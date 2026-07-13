import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  normalizeCandidateContentV1,
  validateSourceLineageReceiptV1,
} from "../application/candidate-content-quality-review.js";
import type { CandidateCaptureSafetyReviewRowV1 } from "../application/candidate-capture-safety-review.js";
import {
  adjudicateCandidateDuplicateTracesV1,
  type CandidateDuplicateTraceAdjudicationV1,
  type CandidateDuplicateTraceGroupDecisionV1,
} from "../application/candidate-duplicate-trace-adjudication.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;

interface CandidateCaptureSafetyControlV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-capture-safety-review-plan";
  proposedReviewId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  automaticArchiveRows: 0;
  authorizesRejectionMutation: false;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  requiresOperatorDecision: true;
  contentQualityPlanDigest: string;
  contentQualityPreviewSha256: string;
  source: LiveCandidateDuplicateTraceAdjudicationPlanV1["source"];
  counts: Record<string, number>;
  summary: Record<string, number>;
  rows: CandidateCaptureSafetyReviewRowV1[];
  planDigest: string;
}

interface DuplicateTraceDecisionControlV1 {
  schemaVersion: 1;
  phase: "clawlore-duplicate-trace-operator-decisions";
  createdAt: string;
  captureSafetyPlanDigest: string;
  captureSafetyPreviewSha256: string;
  readOnly: true;
  authorizesSoftArchive: false;
  authorizesContentRewrite: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  decisions: CandidateDuplicateTraceGroupDecisionV1[];
  decisionDigest: string;
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

export interface LiveCandidateDuplicateTraceAdjudicationPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-duplicate-trace-adjudication-plan";
  createdAt: string;
  proposedAdjudicationId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  proposesSoftArchiveRows: number;
  holdsForBoundedRewriteRows: number;
  mutationReadyRows: 0;
  authorizesRejectionMutation: false;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  requiresSeparateExactApply: true;
  captureSafetyPlanDigest: string;
  captureSafetyPreviewSha256: string;
  decisionControlDigest: string;
  decisionControlSha256: string;
  captureSafetySource: LiveCandidateDuplicateTraceAdjudicationPlanV1["source"];
  appendOnlySourceExtensionRows: number;
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
  summary: CandidateDuplicateTraceAdjudicationV1["summary"];
  groups: CandidateDuplicateTraceAdjudicationV1["groups"];
  rows: CandidateDuplicateTraceAdjudicationV1["rows"];
  planDigest: string;
}

function hash(value: string | Buffer): string {
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

function privateJson(path: string): { value: unknown; sha256: string } {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("duplicate-trace adjudication input must be a non-empty owner-only JSON file");
  }
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function sourceState(db: DatabaseSync): LiveCandidateDuplicateTraceAdjudicationPlanV1["source"] {
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

function appendOnlySourceExtensionRows(
  current: LiveCandidateDuplicateTraceAdjudicationPlanV1["source"],
  baseline: LiveCandidateDuplicateTraceAdjudicationPlanV1["source"],
): number {
  const delta = current.v1Rows - baseline.v1Rows;
  if (
    delta < 0
    || current.v2Rows !== baseline.v2Rows + delta
    || current.candidateRows !== baseline.candidateRows + delta
    || current.compatibilityRows !== baseline.compatibilityRows + delta
    || current.currentFtsRows !== baseline.currentFtsRows + delta
    || current.vectorRows !== baseline.vectorRows + delta
    || current.relationRows !== baseline.relationRows + delta
    || current.activeRows !== baseline.activeRows
    || current.archivedRows !== baseline.archivedRows
    || current.pendingOutboxRows !== baseline.pendingOutboxRows
  ) return -1;
  return delta;
}

function classification(metadata: Record<string, unknown>, evidence: Record<string, unknown>): string {
  const explicit = String(evidence.classification ?? "").trim();
  if (explicit) return explicit;
  const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
  if (source.includes("manual") || source.includes("user")) return "explicit_manual";
  if (source.includes("reflection") || source.includes("summary") || source.includes("digest")) return "reflection_summary";
  if (source.includes("task") && source.includes("experience")) return "task_experience";
  if (source.includes("checkpoint") || source.includes("pressure")) return "operational_checkpoint";
  if (source.includes("capture")) return "auto_capture";
  return "unknown_legacy";
}

function validateCaptureSafetyControl(value: unknown): CandidateCaptureSafetyControlV1 {
  const plan = value as CandidateCaptureSafetyControlV1;
  if (
    plan?.schemaVersion !== 1
    || plan.phase !== "clawlore-candidate-capture-safety-review-plan"
    || plan.readOnly !== true
    || plan.queryOnly !== true
    || plan.emitsMemoryContent !== false
    || plan.emitsTranscriptContent !== false
    || plan.emitsRawIdentifiers !== false
    || plan.automaticArchiveRows !== 0
    || plan.authorizesRejectionMutation !== false
    || plan.authorizesContentRewrite !== false
    || plan.authorizesSoftArchive !== false
    || plan.authorizesHardDelete !== false
    || plan.authorizesLifecycleMutation !== false
    || plan.authorizesVerificationMutation !== false
    || plan.authorizesContextEngine !== false
    || plan.authorizesPromptMutation !== false
    || plan.authorizesFinalRecall !== false
    || plan.requiresOperatorDecision !== true
    || !Array.isArray(plan.rows)
    || !isDigest(plan.planDigest)
  ) throw new Error("duplicate-trace capture-safety control is invalid");
  const core = {
    proposedReviewId: plan.proposedReviewId,
    contentQualityPlanDigest: plan.contentQualityPlanDigest,
    contentQualityPreviewSha256: plan.contentQualityPreviewSha256,
    source: plan.source,
    counts: plan.counts,
    summary: plan.summary,
    rows: plan.rows,
  };
  if (hash(JSON.stringify(core)) !== plan.planDigest) {
    throw new Error("duplicate-trace capture-safety digest is invalid");
  }
  const duplicateRows = plan.rows.filter((row) => row.lane === "exact_duplicate_operational_trace_review");
  if (duplicateRows.length === 0 || duplicateRows.length !== plan.counts.exact_duplicate_operational_trace_review) {
    throw new Error("duplicate-trace capture-safety target count is invalid");
  }
  return plan;
}

function validateDecisionControl(
  value: unknown,
  capturePlan: CandidateCaptureSafetyControlV1,
  captureSha256: string,
): DuplicateTraceDecisionControlV1 {
  const control = value as DuplicateTraceDecisionControlV1;
  if (
    control?.schemaVersion !== 1
    || control.phase !== "clawlore-duplicate-trace-operator-decisions"
    || control.readOnly !== true
    || control.authorizesSoftArchive !== false
    || control.authorizesContentRewrite !== false
    || control.authorizesLifecycleMutation !== false
    || control.authorizesVerificationMutation !== false
    || control.captureSafetyPlanDigest !== capturePlan.planDigest
    || control.captureSafetyPreviewSha256 !== captureSha256
    || !Array.isArray(control.decisions)
    || !isDigest(control.decisionDigest)
  ) throw new Error("duplicate-trace operator decision control is invalid");
  const core = {
    captureSafetyPlanDigest: control.captureSafetyPlanDigest,
    captureSafetyPreviewSha256: control.captureSafetyPreviewSha256,
    decisions: control.decisions,
  };
  if (hash(JSON.stringify(core)) !== control.decisionDigest) {
    throw new Error("duplicate-trace operator decision digest is invalid");
  }
  return control;
}

function assertLiveRowMatchesPlan(row: CandidateContentRow, planned: CandidateCaptureSafetyReviewRowV1): void {
  if (
    row.lifecycle !== "candidate"
    || row.verification !== "unverified"
    || hash(row.item_id) !== planned.itemIdSha256
    || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
    || hash(row.content) !== planned.contentDigest
    || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
    || row.category !== planned.category
  ) throw new Error("duplicate-trace live candidate no longer matches the capture-safety control");
  const metadata = parseRecord(row.metadata);
  const evidence = parseRecord(row.evidence_json);
  const receipt = evidence.sourceLineageReceiptV1;
  if (
    !validateSourceLineageReceiptV1(receipt, classification(metadata, evidence))
    || hash(JSON.stringify(receipt)) !== planned.sourceLineageReceiptDigest
  ) throw new Error("duplicate-trace lineage receipt no longer matches the capture-safety control");
}

export function createLiveCandidateDuplicateTraceAdjudicationPlanV1(input: {
  sourcePath: string;
  captureSafetyPreviewPath: string;
  decisionControlPath: string;
  proposedAdjudicationId: string;
  now?: () => Date;
}): LiveCandidateDuplicateTraceAdjudicationPlanV1 {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedAdjudicationId)) {
    throw new Error("proposed duplicate-trace adjudication id is invalid");
  }
  const loadedCapture = privateJson(input.captureSafetyPreviewPath);
  const capturePlan = validateCaptureSafetyControl(loadedCapture.value);
  const loadedDecisions = privateJson(input.decisionControlPath);
  const decisionControl = validateDecisionControl(loadedDecisions.value, capturePlan, loadedCapture.sha256);
  const plannedByItemHash = new Map(capturePlan.rows.map((row) => [row.itemIdSha256, row]));
  if (plannedByItemHash.size !== capturePlan.rows.length) {
    throw new Error("duplicate-trace capture-safety rows must be unique");
  }

  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const before = sourceState(db);
    const sourceExtensionRows = appendOnlySourceExtensionRows(before, capturePlan.source);
    if (sourceExtensionRows < 0) {
      throw new Error("live source is not an isolated append-only extension of the duplicate-trace control");
    }
    const candidates = db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,
      i.lifecycle,i.verification,l.metadata,
      COALESCE((SELECT s.evidence_json FROM memory_sources s
        WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
      FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all() as CandidateContentRow[];
    if (candidates.length !== before.candidateRows) {
      throw new Error("duplicate-trace candidate mapping is incomplete");
    }
    const liveByItemHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
    for (const [itemHash, planned] of plannedByItemHash) {
      const live = liveByItemHash.get(itemHash);
      if (!live) throw new Error("duplicate-trace capture-safety target mapping is incomplete");
      assertLiveRowMatchesPlan(live, planned);
    }
    const adjudication = adjudicateCandidateDuplicateTracesV1(
      capturePlan.rows.filter((row) => row.lane === "exact_duplicate_operational_trace_review"),
      decisionControl.decisions,
    );
    const after = sourceState(db);
    if (appendOnlySourceExtensionRows(after, before) !== 0) {
      throw new Error("live source changed during duplicate-trace adjudication planning");
    }
    const core = {
      proposedAdjudicationId: input.proposedAdjudicationId,
      captureSafetyPlanDigest: capturePlan.planDigest,
      captureSafetyPreviewSha256: loadedCapture.sha256,
      decisionControlDigest: decisionControl.decisionDigest,
      decisionControlSha256: loadedDecisions.sha256,
      captureSafetySource: capturePlan.source,
      appendOnlySourceExtensionRows: sourceExtensionRows,
      source: before,
      summary: adjudication.summary,
      groups: adjudication.groups,
      rows: adjudication.rows,
    };
    return {
      schemaVersion: 1,
      phase: "clawlore-candidate-duplicate-trace-adjudication-plan",
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      proposedAdjudicationId: input.proposedAdjudicationId,
      readOnly: true,
      queryOnly: true,
      emitsMemoryContent: false,
      emitsTranscriptContent: false,
      emitsRawIdentifiers: false,
      proposesSoftArchiveRows: adjudication.summary.softArchiveRows,
      holdsForBoundedRewriteRows: adjudication.summary.rewriteHoldRows,
      mutationReadyRows: 0,
      authorizesRejectionMutation: false,
      authorizesContentRewrite: false,
      authorizesSoftArchive: false,
      authorizesHardDelete: false,
      authorizesLifecycleMutation: false,
      authorizesVerificationMutation: false,
      authorizesContextEngine: false,
      authorizesPromptMutation: false,
      authorizesFinalRecall: false,
      requiresSeparateExactApply: true,
      ...core,
      planDigest: hash(JSON.stringify(core)),
    };
  } finally {
    db.close();
  }
}
