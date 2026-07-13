import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { CandidateEvidenceRemediationPlanV1 } from "./live-candidate-evidence-remediation.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 2 * 1024 * 1024;

type SourceClassificationV1 = "reflection_summary" | "operational_checkpoint";
type SourceLineageDecisionV1 = "propose_source_lineage_receipt" | "hold_incomplete_lineage";

interface CandidateSourceRow {
  item_id: string;
  current_revision_id: string;
  address_json: string;
  lifecycle: string;
  verification: string;
  legacy_id: string;
  metadata: string;
  metadata_text: string;
  source_id: string;
  source_type: string;
  external_id: string | null;
  observed_at: string;
  evidence_json: string;
}

interface EventRow {
  event_id: string;
  item_id: string;
  revision_id: string;
  event_type: string;
  actor: string;
  reason: string;
  created_at: string;
}

export interface SourceLineageReceiptPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-source-lineage-receipt-plan";
  proposedRolloutId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  sourceLineageOnly: true;
  authorizesEvidenceWrite: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  requiresFreshSnapshotBeforeApply: true;
  remediationPlanDigest: string;
  remediationPreviewSha256: string;
  source: CandidateEvidenceRemediationPlanV1["source"];
  summary: {
    derivedSystemRows: number;
    proposedSourceLineageReceiptRows: number;
    incompleteLineageRows: number;
    nonTargetRows: number;
    lifecycleRowsChanged: 0;
    verificationRowsChanged: 0;
  };
  classifications: Record<SourceClassificationV1, number>;
  decisions: Record<SourceLineageDecisionV1, number>;
  rows: Array<{
    itemIdSha256: string;
    currentStateDigest: string;
    classification: SourceClassificationV1;
    decision: SourceLineageDecisionV1;
    reasonCodes: string[];
    sourceEvidenceDigest: string;
    eventEvidenceDigest?: string;
    proposedReceiptPayloadDigest?: string;
    postLifecycle: "candidate";
    postVerification: string;
    lifecycleMutationAllowed: false;
    verificationMutationAllowed: false;
  }>;
  planDigest: string;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateJson<T>(path: string): { value: T; sha256: string } {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("control input must be a non-empty owner-only JSON file");
  }
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString("utf8")) as T, sha256: hash(bytes) };
}

function record(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function sourceState(db: DatabaseSync): CandidateEvidenceRemediationPlanV1["source"] {
  return {
    v1Rows: scalar(db, "SELECT COUNT(*) FROM memory_truth"),
    v2Rows: scalar(db, "SELECT COUNT(*) FROM memory_items"),
    candidateRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'"),
    activeRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
    archivedRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'"),
    compatibilityRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2"),
    currentFtsRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_v2"),
    vectorRows: scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2"),
    relationRows: scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2"),
    pendingOutboxRows: scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
  };
}

function sameSourceState(
  left: CandidateEvidenceRemediationPlanV1["source"],
  right: CandidateEvidenceRemediationPlanV1["source"],
): boolean {
  return left.v1Rows === right.v1Rows
    && left.v2Rows === right.v2Rows
    && left.candidateRows === right.candidateRows
    && left.activeRows === right.activeRows
    && left.archivedRows === right.archivedRows
    && left.compatibilityRows === right.compatibilityRows
    && left.currentFtsRows === right.currentFtsRows
    && left.vectorRows === right.vectorRows
    && left.relationRows === right.relationRows
    && left.pendingOutboxRows === right.pendingOutboxRows;
}

function assertRemediationContract(value: CandidateEvidenceRemediationPlanV1): void {
  if (
    value.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-evidence-remediation-plan"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.authorizesLifecycleMutation !== false
    || value.automaticPromotionRows !== 0
    || value.summary.mutationReadyRows !== 0
    || !/^[a-f0-9]{64}$/i.test(value.planDigest ?? "")
    || !Array.isArray(value.rows)
  ) throw new Error("remediation preview contract is invalid");
  const core = {
    baselinePhase: value.baselinePhase,
    baselinePromotionPlanDigest: value.baselinePromotionPlanDigest,
    baselinePreviewSha256: value.baselinePreviewSha256,
    source: value.source,
    counts: value.counts,
    summary: value.summary,
    rows: value.rows,
  };
  if (hash(JSON.stringify(core)) !== value.planDigest) {
    throw new Error("remediation preview plan digest is invalid");
  }
}

function classification(evidence: Record<string, unknown>): SourceClassificationV1 | undefined {
  const value = String(evidence.classification ?? "");
  return value === "reflection_summary" || value === "operational_checkpoint" ? value : undefined;
}

function stateDigest(row: CandidateSourceRow): string {
  return hash(JSON.stringify({
    itemId: row.item_id,
    currentRevisionId: row.current_revision_id,
    addressJson: row.address_json,
    lifecycle: row.lifecycle,
    verification: row.verification,
  }));
}

function sourceEvidence(row: CandidateSourceRow, evidence: Record<string, unknown>): Record<string, unknown> {
  return {
    itemIdSha256: hash(row.item_id),
    revisionIdSha256: hash(row.current_revision_id),
    legacyIdSha256: hash(row.legacy_id),
    metadataSha256: hash(row.metadata),
    metadataTextSha256: hash(row.metadata_text),
    sourceIdSha256: hash(row.source_id),
    sourceType: row.source_type,
    externalIdMatchesLegacy: row.external_id === row.legacy_id,
    observedAt: row.observed_at,
    sourceEvidenceJsonSha256: hash(row.evidence_json),
    rolloutIdSha256: typeof evidence.rolloutId === "string" && evidence.rolloutId.trim()
      ? hash(evidence.rolloutId.trim())
      : null,
  };
}

function matchingEvent(row: CandidateSourceRow, evidence: Record<string, unknown>, events: EventRow[]): EventRow | undefined {
  const rolloutId = typeof evidence.rolloutId === "string" ? evidence.rolloutId.trim() : "";
  if (!rolloutId) return undefined;
  const matches = events.filter((event) => event.item_id === row.item_id
    && event.revision_id === row.current_revision_id
    && event.event_type === "remembered"
    && [
      "operator:approved-rollout",
      "operator:approved-delta-rollout",
      "operator:bounded-rollout",
      "operator:bounded-delta-rollout",
    ].includes(event.actor)
    && event.reason === rolloutId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function createLiveSourceLineageReceiptPlanV1(input: {
  sourcePath: string;
  remediationPreviewPath: string;
  proposedRolloutId: string;
}): SourceLineageReceiptPlanV1 {
  if (!input.proposedRolloutId.trim()) throw new Error("proposed rollout id is required");
  const loaded = privateJson<CandidateEvidenceRemediationPlanV1>(input.remediationPreviewPath);
  assertRemediationContract(loaded.value);
  const remediation = loaded.value;
  const remediationRows = new Map(remediation.rows.map((row) => [row.itemIdSha256, row]));
  if (remediationRows.size !== remediation.source.candidateRows) {
    throw new Error("remediation candidate coverage is incomplete");
  }

  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const before = sourceState(db);
    if (!sameSourceState(before, remediation.source)) {
      throw new Error("live source no longer matches remediation preview");
    }
    const candidates = db.prepare(`SELECT i.item_id,i.current_revision_id,i.address_json,i.lifecycle,i.verification,
      l.id AS legacy_id,l.metadata,l.metadata_text,s.source_id,s.source_type,s.external_id,s.observed_at,s.evidence_json
      FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
      JOIN memory_sources s ON s.revision_id=i.current_revision_id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id,s.source_id`).all() as CandidateSourceRow[];
    if (candidates.length !== before.candidateRows) {
      throw new Error("candidate source mapping must be exactly one row per candidate");
    }
    if (candidates.some((row) => !remediationRows.has(hash(row.item_id)))) {
      throw new Error("live candidate set no longer matches remediation preview");
    }
    const events = db.prepare(`SELECT event_id,item_id,revision_id,event_type,actor,reason,created_at
      FROM memory_events WHERE event_type='remembered' ORDER BY event_id`).all() as EventRow[];
    const targets = candidates.filter((row) =>
      remediationRows.get(hash(row.item_id))?.lane === "derived_system_evidence_review");
    const rows = targets.map((row) => {
      const evidence = record(row.evidence_json);
      const kind = classification(evidence);
      const source = sourceEvidence(row, evidence);
      const event = matchingEvent(row, evidence, events);
      const reasonCodes: string[] = [];
      if (!kind) reasonCodes.push("derived_classification_missing_or_unsupported");
      if (row.source_type !== "legacy") reasonCodes.push("legacy_source_type_required");
      if (row.external_id !== row.legacy_id) reasonCodes.push("legacy_external_id_mismatch");
      if (!event) reasonCodes.push("exact_migration_event_missing_or_ambiguous");
      const decision: SourceLineageDecisionV1 = reasonCodes.length === 0
        ? "propose_source_lineage_receipt"
        : "hold_incomplete_lineage";
      const eventEvidence = event ? {
        eventIdSha256: hash(event.event_id),
        itemIdSha256: hash(event.item_id),
        revisionIdSha256: hash(event.revision_id),
        eventType: event.event_type,
        actor: event.actor,
        reasonSha256: hash(event.reason),
        createdAt: event.created_at,
      } : undefined;
      const receiptPayload = decision === "propose_source_lineage_receipt" ? {
        schemaVersion: 1,
        evidenceKind: "source-lineage-receipt",
        supportsSourceLineageOnly: true,
        authorizesLifecycleChange: false,
        authorizesVerificationChange: false,
        classification: kind,
        sourceEvidenceDigest: hash(JSON.stringify(source)),
        eventEvidenceDigest: hash(JSON.stringify(eventEvidence)),
      } : undefined;
      return {
        itemIdSha256: hash(row.item_id),
        currentStateDigest: stateDigest(row),
        classification: kind ?? "operational_checkpoint",
        decision,
        reasonCodes: reasonCodes.length ? reasonCodes : ["exact_legacy_source_and_migration_event"],
        sourceEvidenceDigest: hash(JSON.stringify(source)),
        ...(eventEvidence ? { eventEvidenceDigest: hash(JSON.stringify(eventEvidence)) } : {}),
        ...(receiptPayload ? { proposedReceiptPayloadDigest: hash(JSON.stringify(receiptPayload)) } : {}),
        postLifecycle: "candidate" as const,
        postVerification: row.verification,
        lifecycleMutationAllowed: false as const,
        verificationMutationAllowed: false as const,
      };
    });
    const after = sourceState(db);
    if (!sameSourceState(before, after)) {
      throw new Error("live source changed during read-only lineage planning");
    }
    const classifications: Record<SourceClassificationV1, number> = {
      reflection_summary: rows.filter((row) => row.classification === "reflection_summary").length,
      operational_checkpoint: rows.filter((row) => row.classification === "operational_checkpoint").length,
    };
    const decisions: Record<SourceLineageDecisionV1, number> = {
      propose_source_lineage_receipt: rows.filter((row) => row.decision === "propose_source_lineage_receipt").length,
      hold_incomplete_lineage: rows.filter((row) => row.decision === "hold_incomplete_lineage").length,
    };
    const planCore = {
      proposedRolloutId: input.proposedRolloutId,
      remediationPlanDigest: remediation.planDigest,
      remediationPreviewSha256: loaded.sha256,
      source: before,
      summary: {
        derivedSystemRows: rows.length,
        proposedSourceLineageReceiptRows: decisions.propose_source_lineage_receipt,
        incompleteLineageRows: decisions.hold_incomplete_lineage,
        nonTargetRows: candidates.length - rows.length,
        lifecycleRowsChanged: 0 as const,
        verificationRowsChanged: 0 as const,
      },
      classifications,
      decisions,
      rows,
    };
    return {
      schemaVersion: 1,
      phase: "clawlore-source-lineage-receipt-plan",
      readOnly: true,
      queryOnly: true,
      emitsMemoryContent: false,
      emitsTranscriptContent: false,
      emitsRawIdentifiers: false,
      sourceLineageOnly: true,
      authorizesEvidenceWrite: false,
      authorizesLifecycleMutation: false,
      authorizesVerificationMutation: false,
      authorizesContextEngine: false,
      authorizesPromptMutation: false,
      authorizesFinalRecall: false,
      requiresFreshSnapshotBeforeApply: true,
      ...planCore,
      planDigest: hash(JSON.stringify(planCore)),
    };
  } finally {
    db.close();
  }
}
