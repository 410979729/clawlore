import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  assessCandidateContentQualityV1,
  validateSourceLineageReceiptV1,
  type CandidateContentQualityAssessmentV1,
} from "../application/candidate-content-quality-review.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;

interface RemediationPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-evidence-remediation-plan";
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  automaticPromotionRows: 0;
  authorizesLifecycleMutation: false;
  requiresOperatorReview: true;
  baselinePhase: string;
  baselinePromotionPlanDigest: string;
  baselinePreviewSha256: string;
  source: LiveCandidateContentQualityReviewPlanV1["source"];
  counts: Record<string, number>;
  summary: Record<string, number>;
  rows: Array<{ itemIdSha256: string; lane: string; requiredActions: string[] }>;
  planDigest: string;
}

interface CandidateContentRow {
  item_id: string;
  current_revision_id: string;
  content: string;
  category: string;
  lifecycle: "candidate";
  verification: "unverified";
  metadata: string;
  evidence_json: string;
}

export interface LiveCandidateContentQualityReviewPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-content-quality-review-plan";
  createdAt: string;
  proposedReviewId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  emitsContentDigests: true;
  automaticReviewRows: 0;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  requiresOperatorSemanticReview: true;
  remediationPlanDigest: string;
  remediationPreviewSha256: string;
  source: {
    v1Rows: number;
    v2Rows: number;
    candidateRows: number;
    activeRows: number;
    archivedRows: number;
    compatibilityRows: number;
    currentFtsRows: number;
    vectorRows: number;
    relationRows: number;
    pendingOutboxRows: number;
  };
  counts: CandidateContentQualityAssessmentV1["counts"];
  summary: CandidateContentQualityAssessmentV1["summary"];
  rows: CandidateContentQualityAssessmentV1["rows"];
  planDigest: string;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

function privateJson(path: string): { value: unknown; sha256: string } {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("content review input must be a non-empty owner-only JSON file");
  }
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function sourceState(db: DatabaseSync): LiveCandidateContentQualityReviewPlanV1["source"] {
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

function sourceMatches(
  live: LiveCandidateContentQualityReviewPlanV1["source"],
  expected: LiveCandidateContentQualityReviewPlanV1["source"],
): boolean {
  return live.v1Rows === expected.v1Rows
    && live.v2Rows === expected.v2Rows
    && live.candidateRows === expected.candidateRows
    && live.activeRows === expected.activeRows
    && live.archivedRows === expected.archivedRows
    && live.compatibilityRows === expected.compatibilityRows
    && live.currentFtsRows === expected.currentFtsRows
    && live.vectorRows === expected.vectorRows
    && live.relationRows === expected.relationRows
    && live.pendingOutboxRows === expected.pendingOutboxRows;
}

function classification(metadata: Record<string, unknown>, evidence: Record<string, unknown>): string {
  const explicit = String(evidence.classification ?? "").trim();
  if (explicit) return explicit;
  const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
  if (source.includes("manual") || source.includes("user")) return "explicit_manual";
  if (source.includes("reflection") || source.includes("summary") || source.includes("digest")) {
    return "reflection_summary";
  }
  if (source.includes("task") && source.includes("experience")) return "task_experience";
  if (source.includes("checkpoint") || source.includes("pressure")) return "operational_checkpoint";
  if (source.includes("capture")) return "auto_capture";
  return "unknown_legacy";
}

function validateRemediation(value: unknown): RemediationPlanV1 {
  const plan = value as RemediationPlanV1;
  if (
    plan?.schemaVersion !== 1
    || plan.phase !== "clawlore-candidate-evidence-remediation-plan"
    || plan.readOnly !== true
    || plan.queryOnly !== true
    || plan.emitsMemoryContent !== false
    || plan.emitsTranscriptContent !== false
    || plan.emitsRawIdentifiers !== false
    || plan.automaticPromotionRows !== 0
    || plan.authorizesLifecycleMutation !== false
    || plan.requiresOperatorReview !== true
    || !Array.isArray(plan.rows)
    || !/^[a-f0-9]{64}$/i.test(plan.planDigest ?? "")
  ) throw new Error("content review remediation contract is invalid");
  const core = {
    baselinePhase: plan.baselinePhase,
    baselinePromotionPlanDigest: plan.baselinePromotionPlanDigest,
    baselinePreviewSha256: plan.baselinePreviewSha256,
    source: plan.source,
    counts: plan.counts,
    summary: plan.summary,
    rows: plan.rows,
  };
  if (hash(JSON.stringify(core)) !== plan.planDigest) {
    throw new Error("content review remediation plan digest is invalid");
  }
  const targets = plan.rows.filter((row) => row.lane === "source_lineage_content_review");
  if (targets.length === 0 || targets.length !== plan.counts.source_lineage_content_review) {
    throw new Error("content review remediation target count is invalid");
  }
  if (targets.some((row) => !/^[a-f0-9]{64}$/i.test(row.itemIdSha256))) {
    throw new Error("content review remediation target hash is invalid");
  }
  return plan;
}

export function createLiveCandidateContentQualityReviewPlanV1(input: {
  sourcePath: string;
  remediationPreviewPath: string;
  proposedReviewId: string;
  now?: () => Date;
}): LiveCandidateContentQualityReviewPlanV1 {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedReviewId)) {
    throw new Error("proposed content review id is invalid");
  }
  const loaded = privateJson(input.remediationPreviewPath);
  const remediation = validateRemediation(loaded.value);
  const targetHashes = new Set(remediation.rows
    .filter((row) => row.lane === "source_lineage_content_review")
    .map((row) => row.itemIdSha256));
  if (targetHashes.size !== remediation.counts.source_lineage_content_review) {
    throw new Error("content review remediation targets must be unique");
  }

  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const before = sourceState(db);
    if (!sourceMatches(before, remediation.source)) {
      throw new Error("live source no longer matches the content review remediation preview");
    }
    const candidates = db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,
      i.lifecycle,i.verification,l.metadata,
      COALESCE((SELECT s.evidence_json FROM memory_sources s
        WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
      FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all() as CandidateContentRow[];
    if (candidates.length !== before.candidateRows) throw new Error("content review candidate mapping is incomplete");
    const targetRows = candidates.filter((row) => targetHashes.has(hash(row.item_id)));
    if (targetRows.length !== targetHashes.size) throw new Error("content review target mapping is incomplete");

    const assessmentInputs = targetRows.map((row) => {
      if (row.lifecycle !== "candidate" || row.verification !== "unverified") {
        throw new Error("content review target is no longer candidate/unverified");
      }
      const metadata = parseRecord(row.metadata);
      const evidence = parseRecord(row.evidence_json);
      const receipt = evidence.sourceLineageReceiptV1;
      if (!validateSourceLineageReceiptV1(receipt, classification(metadata, evidence))) {
        throw new Error("content review target has an invalid source-lineage receipt");
      }
      return {
        itemId: row.item_id,
        currentRevisionId: row.current_revision_id,
        content: row.content,
        category: row.category,
        lifecycle: "candidate" as const,
        verification: "unverified" as const,
        sourceLineageReceiptDigest: hash(JSON.stringify(receipt)),
      };
    });
    const corpusRows = db.prepare("SELECT content FROM memory_items ORDER BY item_id").all() as Array<{ content: string }>;
    const corpusContents = corpusRows.map((row) => row.content);
    const assessment = assessCandidateContentQualityV1(assessmentInputs, corpusContents);
    const after = sourceState(db);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("live source changed during query-only content review planning");
    }
    const core = {
      proposedReviewId: input.proposedReviewId,
      remediationPlanDigest: remediation.planDigest,
      remediationPreviewSha256: loaded.sha256,
      source: before,
      counts: assessment.counts,
      summary: assessment.summary,
      rows: assessment.rows,
    };
    return {
      schemaVersion: 1,
      phase: "clawlore-candidate-content-quality-review-plan",
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      proposedReviewId: input.proposedReviewId,
      readOnly: true,
      queryOnly: true,
      emitsMemoryContent: false,
      emitsTranscriptContent: false,
      emitsRawIdentifiers: false,
      emitsContentDigests: true,
      automaticReviewRows: 0,
      authorizesContentRewrite: false,
      authorizesSoftArchive: false,
      authorizesHardDelete: false,
      authorizesLifecycleMutation: false,
      authorizesVerificationMutation: false,
      authorizesContextEngine: false,
      authorizesPromptMutation: false,
      authorizesFinalRecall: false,
      requiresOperatorSemanticReview: true,
      ...core,
      planDigest: hash(JSON.stringify(core)),
    };
  } finally {
    db.close();
  }
}
