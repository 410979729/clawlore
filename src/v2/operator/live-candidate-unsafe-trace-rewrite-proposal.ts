import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { evaluateCaptureSafety } from "../../capture-safety.js";
import {
  normalizeCandidateContentV1,
  validateSourceLineageReceiptV1,
} from "../application/candidate-content-quality-review.js";
import {
  planCandidateUnsafeTraceRewriteProposalV1,
  type CandidateUnsafeTraceRewriteProposalV1,
  type CandidateUnsafeTraceRewriteSpecificationV1,
} from "../application/candidate-unsafe-trace-rewrite-proposal.js";
import {
  companionDispositionSourceStateV1,
  sameCompanionDispositionSourceV1,
  type CompanionDispositionSourceV1,
} from "./live-candidate-companion-disposition.js";
import type {
  LiveCandidateUnsafeTraceArchivePostcheckV1,
  LiveCandidateUnsafeTraceArchiveReceiptV1,
} from "./live-candidate-unsafe-trace-archive.js";
import {
  validateLiveCandidateUnsafeTraceDispositionPlanV1,
  type LiveCandidateUnsafeTraceDispositionPlanV1,
} from "./live-candidate-unsafe-trace-disposition.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const EXPECTED_REWRITE_ROWS = 32;
const EXPECTED_OVERSIZED_ROWS = 7;
const EXPECTED_SEMANTIC_ROWS = 25;

interface UnsafeTraceRewritePayloadV1 {
  schemaVersion: 1;
  phase: "clawlore-unsafe-trace-rewrite-payload";
  createdAt: string;
  dispositionPlanDigest: string;
  dispositionPlanSha256: string;
  archiveApplyReceiptSha256: string;
  archivePostcheckSha256: string;
  readOnly: true;
  containsProposedMemoryContent: true;
  containsOriginalMemoryContent: false;
  containsTranscriptContent: false;
  containsRawIdentifiers: false;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  specifications: CandidateUnsafeTraceRewriteSpecificationV1[];
  payloadDigest: string;
}

interface CandidateRowV1 {
  item_id: string;
  current_revision_id: string;
  content: string;
  category: string;
  lifecycle: "candidate";
  verification: "unverified";
  metadata: string;
  evidence_json: string;
}

export interface LiveCandidateUnsafeTraceRewriteProposalPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-unsafe-trace-rewrite-proposal-plan";
  createdAt: string;
  proposedRewriteId: string;
  readOnly: true;
  queryOnly: true;
  containsProposedMemoryContent: false;
  containsOriginalMemoryContent: false;
  containsTranscriptContent: false;
  emitsRawIdentifiers: false;
  emitsContentDigests: true;
  targetRows: 32;
  oversizedSegmentationRows: 7;
  semanticExtractionRows: 25;
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
  dispositionPlanDigest: string;
  dispositionPlanSha256: string;
  archiveApplyReceiptSha256: string;
  archivePostcheckSha256: string;
  rewritePayloadDigest: string;
  rewritePayloadSha256: string;
  postArchiveSource: CompanionDispositionSourceV1;
  appendOnlySourceExtensionRows: number;
  source: CompanionDispositionSourceV1;
  summary: CandidateUnsafeTraceRewriteProposalV1["summary"] & { liveBindingMismatches: 0 };
  rows: CandidateUnsafeTraceRewriteProposalV1["rows"];
  planDigest: string;
}

export interface LiveCandidateUnsafeTraceRewriteProposalAcceptanceV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-unsafe-trace-rewrite-proposal-acceptance";
  acceptedAt: string;
  status: "pass";
  planDigest: string;
  planSha256: string;
  rewritePayloadDigest: string;
  rewritePayloadSha256: string;
  archivePostcheckSha256: string;
  summary: LiveCandidateUnsafeTraceRewriteProposalPlanV1["summary"];
  live: CompanionDispositionSourceV1;
  liveBindingMismatches: 0;
  proposedContentLeak: false;
  rawTraceOrIdentifierLeak: false;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  requiresFreshEncryptedSnapshot: true;
  requiresSeparateExactApply: true;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function privateJson<T>(path: string): { value: T; bytes: Buffer; sha256: string } {
  if (process.platform === "win32") preparePrivateFileForRead(path);
  const info = statSync(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("unsafe trace rewrite control must be a non-empty owner-only JSON file");
  }
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as T;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unsafe trace rewrite control JSON is invalid");
  }
  return { value, bytes, sha256: hash(bytes) };
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

function candidateRows(db: DatabaseSync): CandidateRowV1[] {
  return db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,
    i.lifecycle,i.verification,l.metadata,
    COALESCE((SELECT s.evidence_json FROM memory_sources s
      WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
    FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
    WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all() as CandidateRowV1[];
}

function appendOnlyConvergedExtensionRows(
  current: CompanionDispositionSourceV1,
  baseline: CompanionDispositionSourceV1,
): number {
  const delta = current.v1Rows - baseline.v1Rows;
  if (
    delta < 0
    || current.v2Rows !== baseline.v2Rows + delta
    || current.candidateRows !== baseline.candidateRows + delta
    || current.activeRows !== baseline.activeRows
    || current.archivedRows !== baseline.archivedRows
    || current.compatibilityRows !== baseline.compatibilityRows + delta
    || current.currentFtsRows !== baseline.currentFtsRows + delta
    || current.vectorRows !== baseline.vectorRows + delta
    || current.relationRows !== baseline.relationRows + delta
    || current.pendingOutboxRows !== baseline.pendingOutboxRows
  ) return -1;
  return delta;
}

function validateArchiveControls(input: {
  plan: LiveCandidateUnsafeTraceDispositionPlanV1;
  planSha256: string;
  apply: LiveCandidateUnsafeTraceArchiveReceiptV1;
  applySha256: string;
  postcheck: LiveCandidateUnsafeTraceArchivePostcheckV1;
}): void {
  const { plan, planSha256, apply, applySha256, postcheck } = input;
  if (
    apply?.schemaVersion !== 1
    || apply.phase !== "clawlore-candidate-unsafe-trace-soft-archive-live-apply"
    || apply.status !== "applied"
    || apply.planDigest !== plan.planDigest
    || apply.planSha256 !== planSha256
    || !sameCompanionDispositionSourceV1(apply.sourceBefore, plan.source)
    || apply.archive.targetRows !== 99
    || apply.archive.candidateRowsArchived !== 99
    || apply.archive.protectedRewriteRows !== EXPECTED_REWRITE_ROWS
    || apply.archive.protectedRewriteRowsChanged !== 0
    || apply.archive.currentContentRowsChanged !== 0
    || apply.archive.currentVerificationRowsChanged !== 0
    || apply.archive.addressRowsChanged !== 0
    || apply.archive.aclRowsChanged !== 0
    || apply.archive.nonTargetRowsChanged !== 0
    || Object.values(apply.projections).some((count) => count !== 0)
    || apply.database.integrity !== "ok"
    || apply.database.foreignKeyViolations !== 0
    || apply.runtime.v1FallbackReads !== true
    || apply.runtime.existingCandidateLifecycleMutationEnabled !== false
    || apply.runtime.contextEngineEnabled !== false
    || apply.runtime.promptMutationEnabled !== false
    || apply.runtime.finalRecallCutoverEnabled !== false
  ) throw new Error("unsafe trace rewrite archive apply control is invalid");
  if (
    postcheck?.schemaVersion !== 1
    || postcheck.phase !== "clawlore-candidate-unsafe-trace-soft-archive-postcheck"
    || postcheck.status !== "pass"
    || postcheck.rolloutId !== apply.rolloutId
    || postcheck.planDigest !== plan.planDigest
    || postcheck.planSha256 !== planSha256
    || postcheck.applyReceiptSha256 !== applySha256
    || !sameCompanionDispositionSourceV1(postcheck.source, apply.sourceAfter)
    || postcheck.targetBinding.archivedRows !== 99
    || postcheck.targetBinding.protectedRewriteRows !== EXPECTED_REWRITE_ROWS
    || postcheck.targetBinding.protectedRewriteRowsChanged !== 0
    || postcheck.targetBinding.validDispositionReceiptRows !== 99
    || postcheck.targetBinding.supersedesRelationRows !== 99
    || postcheck.targetBinding.archivedEventRows !== 99
    || postcheck.targetBinding.projectionBindingRows !== 99
    || postcheck.targetBinding.mismatches !== 0
    || postcheck.database.integrity !== "ok"
    || postcheck.database.foreignKeyViolations !== 0
    || postcheck.runtime.contextEngineEnabled !== false
    || postcheck.runtime.promptMutationEnabled !== false
    || postcheck.runtime.finalRecallCutoverEnabled !== false
  ) throw new Error("unsafe trace rewrite archive postcheck is invalid");
}

function validatePayload(
  value: UnsafeTraceRewritePayloadV1,
  sha256: string,
  disposition: { value: LiveCandidateUnsafeTraceDispositionPlanV1; sha256: string },
  applySha256: string,
  postcheckSha256: string,
): UnsafeTraceRewritePayloadV1 {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-unsafe-trace-rewrite-payload"
    || value.dispositionPlanDigest !== disposition.value.planDigest
    || value.dispositionPlanSha256 !== disposition.sha256
    || value.archiveApplyReceiptSha256 !== applySha256
    || value.archivePostcheckSha256 !== postcheckSha256
    || value.readOnly !== true
    || value.containsProposedMemoryContent !== true
    || value.containsOriginalMemoryContent !== false
    || value.containsTranscriptContent !== false
    || value.containsRawIdentifiers !== false
    || value.authorizesContentRewrite !== false
    || value.authorizesSoftArchive !== false
    || value.authorizesHardDelete !== false
    || value.authorizesLifecycleMutation !== false
    || value.authorizesVerificationMutation !== false
    || !Array.isArray(value.specifications)
    || value.specifications.length !== EXPECTED_REWRITE_ROWS
    || !isDigest(value.payloadDigest)
    || !isDigest(sha256)
  ) throw new Error("unsafe trace rewrite payload is invalid or unbound");
  const core = {
    dispositionPlanDigest: value.dispositionPlanDigest,
    dispositionPlanSha256: value.dispositionPlanSha256,
    archiveApplyReceiptSha256: value.archiveApplyReceiptSha256,
    archivePostcheckSha256: value.archivePostcheckSha256,
    specifications: value.specifications,
  };
  if (hash(JSON.stringify(core)) !== value.payloadDigest) {
    throw new Error("unsafe trace rewrite payload digest is invalid");
  }
  return value;
}

function assertLiveTarget(
  row: CandidateRowV1,
  planned: LiveCandidateUnsafeTraceDispositionPlanV1["rewriteDesigns"][number],
): void {
  const metadata = parseRecord(row.metadata);
  const evidence = parseRecord(row.evidence_json);
  const lineage = evidence.sourceLineageReceiptV1;
  const safety = evaluateCaptureSafety(row.content);
  if (
    row.lifecycle !== "candidate"
    || row.verification !== "unverified"
    || hash(row.item_id) !== planned.itemIdSha256
    || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
    || hash(row.content) !== planned.contentDigest
    || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
    || row.category !== planned.category
    || safety.allowed !== false
    || safety.reason !== "operational-trace"
    || safety.pattern !== planned.captureSafetyPattern
    || !validateSourceLineageReceiptV1(lineage, classification(metadata, evidence))
    || hash(JSON.stringify(lineage)) !== planned.sourceLineageReceiptDigest
  ) throw new Error("unsafe trace rewrite live target no longer matches the protected design");
}

function planCore(value: LiveCandidateUnsafeTraceRewriteProposalPlanV1) {
  return {
    proposedRewriteId: value.proposedRewriteId,
    dispositionPlanDigest: value.dispositionPlanDigest,
    dispositionPlanSha256: value.dispositionPlanSha256,
    archiveApplyReceiptSha256: value.archiveApplyReceiptSha256,
    archivePostcheckSha256: value.archivePostcheckSha256,
    rewritePayloadDigest: value.rewritePayloadDigest,
    rewritePayloadSha256: value.rewritePayloadSha256,
    postArchiveSource: value.postArchiveSource,
    appendOnlySourceExtensionRows: value.appendOnlySourceExtensionRows,
    source: value.source,
    summary: value.summary,
    rows: value.rows,
  };
}

export function validateLiveCandidateUnsafeTraceRewriteProposalPlanV1(
  value: LiveCandidateUnsafeTraceRewriteProposalPlanV1,
  expectedDigest?: string,
): LiveCandidateUnsafeTraceRewriteProposalPlanV1 {
  const proposedDurableRows = Array.isArray(value?.rows)
    ? value.rows.reduce((total, row) => total + (Array.isArray(row.outputs) ? row.outputs.length : 0), 0)
    : -1;
  const outputNormalizedDigests = Array.isArray(value?.rows)
    ? value.rows.flatMap((row) => Array.isArray(row.outputs)
      ? row.outputs.map((output) => output.proposedNormalizedContentDigest)
      : [])
    : [];
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-unsafe-trace-rewrite-proposal-plan"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.containsProposedMemoryContent !== false
    || value.containsOriginalMemoryContent !== false
    || value.containsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.emitsContentDigests !== true
    || value.targetRows !== EXPECTED_REWRITE_ROWS
    || value.oversizedSegmentationRows !== EXPECTED_OVERSIZED_ROWS
    || value.semanticExtractionRows !== EXPECTED_REWRITE_ROWS - EXPECTED_OVERSIZED_ROWS
    || value.mutationReadyRows !== 0
    || value.authorizesContentRewrite !== false
    || value.authorizesSoftArchive !== false
    || value.authorizesHardDelete !== false
    || value.authorizesLifecycleMutation !== false
    || value.authorizesVerificationMutation !== false
    || value.authorizesContextEngine !== false
    || value.authorizesPromptMutation !== false
    || value.authorizesFinalRecall !== false
    || value.requiresFreshEncryptedSnapshot !== true
    || value.requiresSeparateExactApply !== true
    || value.appendOnlySourceExtensionRows < 0
    || value.summary.targetRows !== EXPECTED_REWRITE_ROWS
    || value.summary.oversizedSegmentationRows !== EXPECTED_OVERSIZED_ROWS
    || value.summary.semanticExtractionRows !== EXPECTED_REWRITE_ROWS - EXPECTED_OVERSIZED_ROWS
    || value.summary.proposedDurableRows !== proposedDurableRows
    || value.summary.captureSafeProposals !== value.summary.proposedDurableRows
    || value.summary.proposedDurableRows < EXPECTED_REWRITE_ROWS
    || value.summary.proposedDurableRows > EXPECTED_REWRITE_ROWS + EXPECTED_OVERSIZED_ROWS * 3
    || value.summary.coveredByExistingTruthRows
      !== value.rows.filter((row) => row.knowledgeCoverage === "covered_by_existing_truth").length
    || value.summary.materiallyNewTruthRows
      !== value.rows.filter((row) => row.knowledgeCoverage === "materially_new_bounded_truth").length
    || value.summary.corpusCollisionRows !== 0
    || value.summary.mutationReadyRows !== 0
    || value.summary.liveBindingMismatches !== 0
    || !Array.isArray(value.rows)
    || value.rows.length !== EXPECTED_REWRITE_ROWS
    || new Set(value.rows.map((row) => row.itemIdSha256)).size !== EXPECTED_REWRITE_ROWS
    || value.rows.filter((row) => row.rewriteDesign === "segment_oversized_result").length !== EXPECTED_OVERSIZED_ROWS
    || value.rows.filter((row) => row.rewriteDesign === "extract_durable_result").length !== EXPECTED_SEMANTIC_ROWS
    || value.rows.some((row) => row.proposedAction !== "hold_for_separate_exact_rewrite_apply"
      || row.mutationReady !== false || row.proposedLifecycle !== "candidate"
      || row.proposedVerification !== "unverified" || row.removeCommandAndToolEnvelope !== true
      || row.requireCaptureSafetyPass !== true || row.requireCorpusDeduplication !== true
      || row.outputs.length !== row.proposedOutputRows || row.outputs.length === 0
      || row.maximumProposedRows !== (row.rewriteDesign === "segment_oversized_result" ? 4 : 1)
      || row.outputs.length > row.maximumProposedRows
      || ![
        row.itemIdSha256,
        row.currentRevisionIdSha256,
        row.contentDigest,
        row.normalizedContentDigest,
        row.sourceLineageReceiptDigest,
        row.resultDigest,
        row.knowledgeEvidenceDigest,
      ].every(isDigest)
      || row.outputs.some((output, index) => output.ordinal !== index + 1
        || !isDigest(output.proposedContentDigest)
        || !isDigest(output.proposedNormalizedContentDigest)
        || !Number.isInteger(output.proposedContentLength)
        || output.proposedContentLength < 40
        || output.proposedContentLength > 1_000
        || output.captureSafetyAllowed !== true
        || output.corpusCollisionRows !== 0))
    || new Set(outputNormalizedDigests).size !== outputNormalizedDigests.length
    || appendOnlyConvergedExtensionRows(value.source, value.postArchiveSource)
      !== value.appendOnlySourceExtensionRows
    || !isDigest(value.planDigest)
    || (expectedDigest !== undefined && value.planDigest !== expectedDigest)
  ) throw new Error("unsafe trace rewrite proposal plan is invalid or mutation-capable");
  if (hash(JSON.stringify(planCore(value))) !== value.planDigest) {
    throw new Error("unsafe trace rewrite proposal plan digest is invalid");
  }
  return value;
}

function loadBoundControls(input: {
  dispositionPlanPath: string;
  archiveApplyReceiptPath: string;
  archivePostcheckPath: string;
  rewritePayloadPath: string;
}) {
  const disposition = privateJson<LiveCandidateUnsafeTraceDispositionPlanV1>(input.dispositionPlanPath);
  validateLiveCandidateUnsafeTraceDispositionPlanV1(disposition.value);
  const apply = privateJson<LiveCandidateUnsafeTraceArchiveReceiptV1>(input.archiveApplyReceiptPath);
  const postcheck = privateJson<LiveCandidateUnsafeTraceArchivePostcheckV1>(input.archivePostcheckPath);
  validateArchiveControls({
    plan: disposition.value,
    planSha256: disposition.sha256,
    apply: apply.value,
    applySha256: apply.sha256,
    postcheck: postcheck.value,
  });
  const payload = privateJson<UnsafeTraceRewritePayloadV1>(input.rewritePayloadPath);
  validatePayload(payload.value, payload.sha256, disposition, apply.sha256, postcheck.sha256);
  return { disposition, apply, postcheck, payload };
}

function buildProposal(input: {
  sourcePath: string;
  controls: ReturnType<typeof loadBoundControls>;
}) {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const source = companionDispositionSourceStateV1(db);
    const extensionRows = appendOnlyConvergedExtensionRows(source, input.controls.postcheck.value.source);
    if (extensionRows < 0) {
      throw new Error("live source is not a fully converged append-only extension of the archive postcheck");
    }
    const candidates = candidateRows(db);
    if (candidates.length !== source.candidateRows) {
      throw new Error("unsafe trace rewrite candidate mapping is incomplete");
    }
    const liveByHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
    for (const planned of input.controls.disposition.value.rewriteDesigns) {
      const live = liveByHash.get(planned.itemIdSha256);
      if (!live) throw new Error("unsafe trace rewrite target mapping is incomplete");
      assertLiveTarget(live, planned);
    }
    const proposal = planCandidateUnsafeTraceRewriteProposalV1(
      input.controls.disposition.value.rewriteDesigns,
      input.controls.payload.value.specifications,
      candidates.map((row) => row.content),
    );
    if (!sameCompanionDispositionSourceV1(source, companionDispositionSourceStateV1(db))) {
      throw new Error("live source changed during unsafe trace rewrite planning");
    }
    return { source, extensionRows, proposal };
  } finally {
    db.close();
  }
}

export function createLiveCandidateUnsafeTraceRewriteProposalPlanV1(input: {
  sourcePath: string;
  dispositionPlanPath: string;
  archiveApplyReceiptPath: string;
  archivePostcheckPath: string;
  rewritePayloadPath: string;
  proposedRewriteId: string;
  now?: () => Date;
}): LiveCandidateUnsafeTraceRewriteProposalPlanV1 {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedRewriteId)) {
    throw new Error("unsafe trace rewrite id is invalid");
  }
  const controls = loadBoundControls(input);
  const built = buildProposal({ sourcePath: input.sourcePath, controls });
  const summary = { ...built.proposal.summary, liveBindingMismatches: 0 as const };
  const core = {
    proposedRewriteId: input.proposedRewriteId,
    dispositionPlanDigest: controls.disposition.value.planDigest,
    dispositionPlanSha256: controls.disposition.sha256,
    archiveApplyReceiptSha256: controls.apply.sha256,
    archivePostcheckSha256: controls.postcheck.sha256,
    rewritePayloadDigest: controls.payload.value.payloadDigest,
    rewritePayloadSha256: controls.payload.sha256,
    postArchiveSource: controls.postcheck.value.source,
    appendOnlySourceExtensionRows: built.extensionRows,
    source: built.source,
    summary,
    rows: built.proposal.rows,
  };
  return {
    schemaVersion: 1,
    phase: "clawlore-candidate-unsafe-trace-rewrite-proposal-plan",
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    readOnly: true,
    queryOnly: true,
    containsProposedMemoryContent: false,
    containsOriginalMemoryContent: false,
    containsTranscriptContent: false,
    emitsRawIdentifiers: false,
    emitsContentDigests: true,
    targetRows: EXPECTED_REWRITE_ROWS,
    oversizedSegmentationRows: EXPECTED_OVERSIZED_ROWS,
    semanticExtractionRows: EXPECTED_SEMANTIC_ROWS,
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
}

export function acceptLiveCandidateUnsafeTraceRewriteProposalV1(input: {
  sourcePath: string;
  dispositionPlanPath: string;
  archiveApplyReceiptPath: string;
  archivePostcheckPath: string;
  rewritePayloadPath: string;
  proposalPlanPath: string;
  now?: () => Date;
}): LiveCandidateUnsafeTraceRewriteProposalAcceptanceV1 {
  const controls = loadBoundControls(input);
  const loadedPlan = privateJson<LiveCandidateUnsafeTraceRewriteProposalPlanV1>(input.proposalPlanPath);
  const plan = validateLiveCandidateUnsafeTraceRewriteProposalPlanV1(loadedPlan.value);
  const built = buildProposal({ sourcePath: input.sourcePath, controls });
  const expectedSummary = { ...built.proposal.summary, liveBindingMismatches: 0 as const };
  if (
    plan.dispositionPlanDigest !== controls.disposition.value.planDigest
    || plan.dispositionPlanSha256 !== controls.disposition.sha256
    || plan.archiveApplyReceiptSha256 !== controls.apply.sha256
    || plan.archivePostcheckSha256 !== controls.postcheck.sha256
    || plan.rewritePayloadDigest !== controls.payload.value.payloadDigest
    || plan.rewritePayloadSha256 !== controls.payload.sha256
    || !sameCompanionDispositionSourceV1(plan.postArchiveSource, controls.postcheck.value.source)
    || plan.appendOnlySourceExtensionRows !== built.extensionRows
    || !sameCompanionDispositionSourceV1(plan.source, built.source)
    || JSON.stringify(plan.summary) !== JSON.stringify(expectedSummary)
    || JSON.stringify(plan.rows) !== JSON.stringify(built.proposal.rows)
  ) throw new Error("unsafe trace rewrite proposal acceptance no longer matches live truth");

  const serializedPlan = loadedPlan.bytes.toString("utf8");
  for (const specification of controls.payload.value.specifications) {
    for (const proposedContent of specification.proposedContents) {
      if (serializedPlan.includes(proposedContent)) {
        throw new Error("unsafe trace rewrite proposal plan leaked proposed memory content");
      }
    }
  }
  for (const marker of ["legacy:", "revision:", "Command hints:", "Files:\n", "/home/", "/tmp/"]) {
    if (serializedPlan.includes(marker)) throw new Error("unsafe trace rewrite proposal plan leaked raw trace material");
  }
  return {
    schemaVersion: 1,
    phase: "clawlore-candidate-unsafe-trace-rewrite-proposal-acceptance",
    acceptedAt: (input.now ?? (() => new Date()))().toISOString(),
    status: "pass",
    planDigest: plan.planDigest,
    planSha256: loadedPlan.sha256,
    rewritePayloadDigest: controls.payload.value.payloadDigest,
    rewritePayloadSha256: controls.payload.sha256,
    archivePostcheckSha256: controls.postcheck.sha256,
    summary: plan.summary,
    live: built.source,
    liveBindingMismatches: 0,
    proposedContentLeak: false,
    rawTraceOrIdentifierLeak: false,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    requiresFreshEncryptedSnapshot: true,
    requiresSeparateExactApply: true,
  };
}
