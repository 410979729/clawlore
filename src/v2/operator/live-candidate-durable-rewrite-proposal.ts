import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  normalizeCandidateContentV1,
  validateSourceLineageReceiptV1,
} from "../application/candidate-content-quality-review.js";
import type {
  CandidateDuplicateTraceAdjudicationRowV1,
  CandidateDuplicateTraceAdjudicationV1,
} from "../application/candidate-duplicate-trace-adjudication.js";
import {
  planCandidateDurableRewriteProposalV1,
  type CandidateDurableRewriteProposalV1,
  type CandidateDurableRewriteSpecificationV1,
} from "../application/candidate-durable-rewrite-proposal.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;

interface SourceStateV1 {
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
}

interface DuplicateTraceAdjudicationControlV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-duplicate-trace-adjudication-plan";
  proposedAdjudicationId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  mutationReadyRows: 0;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
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
  captureSafetySource: SourceStateV1;
  appendOnlySourceExtensionRows: number;
  source: SourceStateV1;
  summary: CandidateDuplicateTraceAdjudicationV1["summary"];
  groups: CandidateDuplicateTraceAdjudicationV1["groups"];
  rows: CandidateDuplicateTraceAdjudicationRowV1[];
  planDigest: string;
}

interface DurableRewritePayloadControlV1 {
  schemaVersion: 1;
  phase: "clawlore-durable-duplicate-rewrite-payload";
  createdAt: string;
  adjudicationPlanDigest: string;
  adjudicationPreviewSha256: string;
  readOnly: true;
  containsProposedMemoryContent: true;
  containsOriginalMemoryContent: false;
  containsTranscriptContent: false;
  containsRawIdentifiers: false;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  specifications: CandidateDurableRewriteSpecificationV1[];
  payloadDigest: string;
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

export interface LiveCandidateDurableRewriteProposalPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-durable-rewrite-proposal-plan";
  createdAt: string;
  proposedRewriteId: string;
  readOnly: true;
  queryOnly: true;
  containsProposedMemoryContent: false;
  containsOriginalMemoryContent: false;
  containsTranscriptContent: false;
  emitsRawIdentifiers: false;
  rewriteRepresentativeRows: number;
  postRewriteDedupeHoldRows: number;
  mutationReadyRows: 0;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  requiresFreshEncryptedSnapshot: true;
  requiresSeparateExactApply: true;
  adjudicationPlanDigest: string;
  adjudicationPreviewSha256: string;
  rewritePayloadDigest: string;
  rewritePayloadSha256: string;
  adjudicationSource: SourceStateV1;
  appendOnlySourceExtensionRows: number;
  source: SourceStateV1;
  summary: CandidateDurableRewriteProposalV1["summary"];
  groups: CandidateDurableRewriteProposalV1["groups"];
  rows: CandidateDurableRewriteProposalV1["rows"];
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
  if (process.platform === "win32") preparePrivateFileForRead(path);
  const info = statSync(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("durable rewrite input must be a non-empty owner-only JSON file");
  }
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

function sourceState(db: DatabaseSync): SourceStateV1 {
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

function appendOnlySourceExtensionRows(current: SourceStateV1, baseline: SourceStateV1): number {
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

function validateAdjudicationControl(value: unknown): DuplicateTraceAdjudicationControlV1 {
  const plan = value as DuplicateTraceAdjudicationControlV1;
  if (
    plan?.schemaVersion !== 1
    || plan.phase !== "clawlore-candidate-duplicate-trace-adjudication-plan"
    || plan.readOnly !== true
    || plan.queryOnly !== true
    || plan.emitsMemoryContent !== false
    || plan.emitsTranscriptContent !== false
    || plan.emitsRawIdentifiers !== false
    || plan.mutationReadyRows !== 0
    || plan.authorizesContentRewrite !== false
    || plan.authorizesSoftArchive !== false
    || plan.authorizesLifecycleMutation !== false
    || plan.authorizesVerificationMutation !== false
    || plan.authorizesContextEngine !== false
    || plan.authorizesPromptMutation !== false
    || plan.authorizesFinalRecall !== false
    || plan.requiresSeparateExactApply !== true
    || !Array.isArray(plan.rows)
    || !Array.isArray(plan.groups)
    || !isDigest(plan.planDigest)
  ) throw new Error("durable rewrite adjudication control is invalid");
  const core = {
    proposedAdjudicationId: plan.proposedAdjudicationId,
    captureSafetyPlanDigest: plan.captureSafetyPlanDigest,
    captureSafetyPreviewSha256: plan.captureSafetyPreviewSha256,
    decisionControlDigest: plan.decisionControlDigest,
    decisionControlSha256: plan.decisionControlSha256,
    captureSafetySource: plan.captureSafetySource,
    appendOnlySourceExtensionRows: plan.appendOnlySourceExtensionRows,
    source: plan.source,
    summary: plan.summary,
    groups: plan.groups,
    rows: plan.rows,
  };
  if (hash(JSON.stringify(core)) !== plan.planDigest) {
    throw new Error("durable rewrite adjudication digest is invalid");
  }
  const rewriteRows = plan.rows.filter((row) => row.disposition === "hold_for_bounded_rewrite");
  if (rewriteRows.length === 0 || rewriteRows.length !== plan.summary.rewriteHoldRows) {
    throw new Error("durable rewrite adjudication target count is invalid");
  }
  return plan;
}

function validateRewritePayload(
  value: unknown,
  adjudication: DuplicateTraceAdjudicationControlV1,
  adjudicationSha256: string,
): DurableRewritePayloadControlV1 {
  const payload = value as DurableRewritePayloadControlV1;
  if (
    payload?.schemaVersion !== 1
    || payload.phase !== "clawlore-durable-duplicate-rewrite-payload"
    || payload.readOnly !== true
    || payload.containsProposedMemoryContent !== true
    || payload.containsOriginalMemoryContent !== false
    || payload.containsTranscriptContent !== false
    || payload.containsRawIdentifiers !== false
    || payload.authorizesContentRewrite !== false
    || payload.authorizesSoftArchive !== false
    || payload.authorizesLifecycleMutation !== false
    || payload.authorizesVerificationMutation !== false
    || payload.adjudicationPlanDigest !== adjudication.planDigest
    || payload.adjudicationPreviewSha256 !== adjudicationSha256
    || !Array.isArray(payload.specifications)
    || !isDigest(payload.payloadDigest)
  ) throw new Error("durable rewrite payload control is invalid");
  const core = {
    adjudicationPlanDigest: payload.adjudicationPlanDigest,
    adjudicationPreviewSha256: payload.adjudicationPreviewSha256,
    specifications: payload.specifications,
  };
  if (hash(JSON.stringify(core)) !== payload.payloadDigest) {
    throw new Error("durable rewrite payload digest is invalid");
  }
  return payload;
}

function assertLiveRowMatchesPlan(row: CandidateContentRow, planned: CandidateDuplicateTraceAdjudicationRowV1): void {
  if (
    row.lifecycle !== "candidate"
    || row.verification !== "unverified"
    || hash(row.item_id) !== planned.itemIdSha256
    || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
    || hash(row.content) !== planned.contentDigest
    || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
    || row.category !== planned.category
  ) throw new Error("durable rewrite live candidate no longer matches the adjudication control");
  const metadata = parseRecord(row.metadata);
  const evidence = parseRecord(row.evidence_json);
  const receipt = evidence.sourceLineageReceiptV1;
  if (
    !validateSourceLineageReceiptV1(receipt, classification(metadata, evidence))
    || hash(JSON.stringify(receipt)) !== planned.sourceLineageReceiptDigest
  ) throw new Error("durable rewrite lineage receipt no longer matches the adjudication control");
}

export function createLiveCandidateDurableRewriteProposalPlanV1(input: {
  sourcePath: string;
  adjudicationPreviewPath: string;
  rewritePayloadPath: string;
  proposedRewriteId: string;
  now?: () => Date;
}): LiveCandidateDurableRewriteProposalPlanV1 {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedRewriteId)) {
    throw new Error("proposed durable rewrite id is invalid");
  }
  const loadedAdjudication = privateJson(input.adjudicationPreviewPath);
  const adjudication = validateAdjudicationControl(loadedAdjudication.value);
  const loadedPayload = privateJson(input.rewritePayloadPath);
  const payload = validateRewritePayload(loadedPayload.value, adjudication, loadedAdjudication.sha256);
  const rewriteRows = adjudication.rows.filter((row) => row.disposition === "hold_for_bounded_rewrite");

  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const before = sourceState(db);
    const sourceExtensionRows = appendOnlySourceExtensionRows(before, adjudication.source);
    if (sourceExtensionRows < 0) {
      throw new Error("live source is not an isolated append-only extension of the durable rewrite control");
    }
    const candidates = db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,
      i.lifecycle,i.verification,l.metadata,
      COALESCE((SELECT s.evidence_json FROM memory_sources s
        WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
      FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all() as CandidateContentRow[];
    if (candidates.length !== before.candidateRows) {
      throw new Error("durable rewrite candidate mapping is incomplete");
    }
    const liveByItemHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
    for (const planned of rewriteRows) {
      const live = liveByItemHash.get(planned.itemIdSha256);
      if (!live) throw new Error("durable rewrite target mapping is incomplete");
      assertLiveRowMatchesPlan(live, planned);
    }
    const proposal = planCandidateDurableRewriteProposalV1(
      rewriteRows,
      payload.specifications,
      candidates.map((row) => row.content),
    );
    const after = sourceState(db);
    if (appendOnlySourceExtensionRows(after, before) !== 0) {
      throw new Error("live source changed during durable rewrite planning");
    }
    const core = {
      proposedRewriteId: input.proposedRewriteId,
      adjudicationPlanDigest: adjudication.planDigest,
      adjudicationPreviewSha256: loadedAdjudication.sha256,
      rewritePayloadDigest: payload.payloadDigest,
      rewritePayloadSha256: loadedPayload.sha256,
      adjudicationSource: adjudication.source,
      appendOnlySourceExtensionRows: sourceExtensionRows,
      source: before,
      summary: proposal.summary,
      groups: proposal.groups,
      rows: proposal.rows,
    };
    return {
      schemaVersion: 1,
      phase: "clawlore-candidate-durable-rewrite-proposal-plan",
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      readOnly: true,
      queryOnly: true,
      containsProposedMemoryContent: false,
      containsOriginalMemoryContent: false,
      containsTranscriptContent: false,
      emitsRawIdentifiers: false,
      rewriteRepresentativeRows: proposal.summary.rewriteRepresentativeRows,
      postRewriteDedupeHoldRows: proposal.summary.postRewriteDedupeHoldRows,
      mutationReadyRows: 0,
      authorizesContentRewrite: false,
      authorizesSoftArchive: false,
      authorizesHardDelete: false,
      authorizesLifecycleMutation: false,
      authorizesVerificationMutation: false,
      authorizesContextEngine: false,
      authorizesPromptMutation: false,
      authorizesFinalRecall: false,
      requiresFreshEncryptedSnapshot: true,
      requiresSeparateExactApply: true,
      ...core,
      planDigest: hash(JSON.stringify(core)),
    };
  } finally {
    db.close();
  }
}
