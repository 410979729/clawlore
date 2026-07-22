import { evaluateCaptureSafety } from "../../capture-safety.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { normalizeCandidateContentV1 } from "../application/candidate-content-quality-review.js";
import {
  companionDispositionSourceStateV1,
  sameCompanionDispositionSourceV1,
} from "./live-candidate-companion-disposition.js";
import {
  candidateGovernanceSourceLogicalDigestV1,
  validateAppendedCandidateArchiveDecisionControlV1,
  type AppendedCandidateArchiveDecisionControlV1,
  type AppendedCandidateArchiveDecisionRowV1,
} from "./live-candidate-governance-archive-plan.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const APPENDED_TARGET_ROWS = 88;

interface AppendedCandidateRowV1 {
  item_id: string;
  current_revision_id: string;
  content: string;
  category: string;
  evidence_json: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function candidates(db: DatabaseSync): AppendedCandidateRowV1[] {
  return db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,s.evidence_json
    FROM memory_items i JOIN memory_sources s ON s.source_id=(SELECT s2.source_id FROM memory_sources s2
      WHERE s2.revision_id=i.current_revision_id ORDER BY s2.source_id LIMIT 1)
    WHERE i.lifecycle='candidate' AND i.verification='unverified' ORDER BY i.item_id`).all() as AppendedCandidateRowV1[];
}

function decisionCore(value: AppendedCandidateArchiveDecisionControlV1): unknown {
  return {
    decisionId: value.decisionId,
    sourceRolloutId: value.sourceRolloutId,
    source: value.source,
    sourceLogicalDigest: value.sourceLogicalDigest,
    summary: value.summary,
    rows: value.rows,
  };
}

export function createAppendedCandidateArchiveDecisionControlV1(input: {
  sourcePath: string;
  decisionId: string;
  sourceRolloutId: string;
  explicitManualContentDigest: string;
  unknownLegacyContentDigest: string;
  now?: () => Date;
}): AppendedCandidateArchiveDecisionControlV1 {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.decisionId)
    || !/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.sourceRolloutId)
    || !isDigest(input.explicitManualContentDigest)
    || !isDigest(input.unknownLegacyContentDigest)) {
    throw new Error("appended candidate decision inputs are invalid");
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const source = companionDispositionSourceStateV1(db);
    const sourceLogicalDigest = candidateGovernanceSourceLogicalDigestV1(db);
    const appended = candidates(db).filter((row) => {
      const evidence = parseRecord(row.evidence_json);
      return evidence.appendOnlyV1Delta === true && evidence.rolloutId === input.sourceRolloutId;
    });
    if (appended.length !== APPENDED_TARGET_ROWS) throw new Error("appended candidate decision target set is not exactly 88 rows");
    const rows = appended.map((row): AppendedCandidateArchiveDecisionRowV1 => {
      const evidence = parseRecord(row.evidence_json);
      const classification = String(evidence.classification) as AppendedCandidateArchiveDecisionRowV1["classification"];
      if (!["reflection_summary", "operational_checkpoint", "explicit_manual", "unknown_legacy"].includes(classification)) {
        throw new Error("appended candidate classification is outside the reviewed lane");
      }
      const contentDigest = hash(row.content);
      const safety = evaluateCaptureSafety(row.content);
      let reason: AppendedCandidateArchiveDecisionRowV1["reason"];
      if (classification === "reflection_summary") {
        reason = safety.allowed ? "transient_reflection_summary" : "capture_unsafe_automatic_trace";
      } else if (classification === "operational_checkpoint") {
        reason = "operational_checkpoint_noise";
      } else if (classification === "explicit_manual") {
        if (contentDigest !== input.explicitManualContentDigest) throw new Error("explicit manual review digest no longer matches");
        reason = "obsolete_cross_instance_policy";
      } else {
        if (contentDigest !== input.unknownLegacyContentDigest) throw new Error("unknown legacy review digest no longer matches");
        reason = "reflection_event_trace";
      }
      const reviewEvidenceDigest = hash(JSON.stringify({
        decisionId: input.decisionId,
        sourceRolloutId: input.sourceRolloutId,
        classification,
        contentDigest,
        reason,
        captureSafetyAllowed: safety.allowed,
        captureSafetyReason: safety.reason ?? null,
      }));
      return {
        itemIdSha256: hash(row.item_id),
        currentRevisionIdSha256: hash(row.current_revision_id),
        contentDigest,
        normalizedContentDigest: hash(normalizeCandidateContentV1(row.content)),
        category: row.category,
        classification,
        sourceEvidenceDigest: hash(row.evidence_json),
        captureSafetyAllowed: safety.allowed,
        ...(safety.reason ? { captureSafetyReason: safety.reason } : {}),
        reason,
        disposition: "propose_soft_archive",
        proposedNextAction: "soft_archive_under_separate_exact_apply",
        mutationReady: false,
        proposedLifecycle: "candidate",
        proposedVerification: "unverified",
        reviewEvidenceDigest,
      };
    }).sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
    const count = (classification: AppendedCandidateArchiveDecisionRowV1["classification"]): number =>
      rows.filter((row) => row.classification === classification).length;
    const summary: AppendedCandidateArchiveDecisionControlV1["summary"] = {
      reviewedRows: 88,
      proposedSoftArchiveRows: 88,
      reflectionSummaryRows: count("reflection_summary") as 66,
      operationalCheckpointRows: count("operational_checkpoint") as 20,
      explicitManualRows: count("explicit_manual") as 1,
      unknownLegacyRows: count("unknown_legacy") as 1,
      captureSafetyRejectedRows: rows.filter((row) => !row.captureSafetyAllowed).length,
      captureSafetyAllowedRows: rows.filter((row) => row.captureSafetyAllowed).length,
      mutationReadyRows: 0,
    };
    if (summary.reflectionSummaryRows !== 66 || summary.operationalCheckpointRows !== 20
      || summary.explicitManualRows !== 1 || summary.unknownLegacyRows !== 1) {
      throw new Error("appended candidate classification counts no longer match the reviewed 66/20/1/1 lane");
    }
    if (!sameCompanionDispositionSourceV1(source, companionDispositionSourceStateV1(db))
      || sourceLogicalDigest !== candidateGovernanceSourceLogicalDigestV1(db)) {
      throw new Error("source changed during appended candidate decision planning");
    }
    const partial = {
      schemaVersion: 1 as const,
      phase: "clawlore-appended-candidate-archive-operator-decisions" as const,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      decisionId: input.decisionId,
      sourceRolloutId: input.sourceRolloutId,
      readOnly: true as const,
      queryOnly: true as const,
      emitsMemoryContent: false as const,
      emitsTranscriptContent: false as const,
      emitsRawIdentifiers: false as const,
      emitsContentDigests: true as const,
      authorizesSoftArchive: false as const,
      authorizesLifecycleMutation: false as const,
      requiresSeparateExactApply: true as const,
      source,
      sourceLogicalDigest,
      summary,
      rows,
    };
    return validateAppendedCandidateArchiveDecisionControlV1({
      ...partial,
      decisionDigest: hash(JSON.stringify(decisionCore(partial as AppendedCandidateArchiveDecisionControlV1))),
    });
  } finally {
    db.close();
  }
}
