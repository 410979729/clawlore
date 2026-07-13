import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { evaluateCaptureSafety } from "../../capture-safety.js";
import {
  normalizeCandidateContentV1,
  validateSourceLineageReceiptV1,
} from "../application/candidate-content-quality-review.js";
import {
  planCandidateUnsafeTraceDispositionV1,
} from "../application/candidate-unsafe-trace-disposition.js";
import type { CandidateUnsafeTraceAdjudicationRowV1 } from "../application/candidate-unsafe-trace-adjudication.js";
import {
  companionDispositionSourceStateV1,
  sameCompanionDispositionSourceV1,
  type CompanionDispositionSourceV1,
} from "./live-candidate-companion-disposition.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const EXPECTED_TARGET_ROWS = 131;
const EXPECTED_ARCHIVE_ROWS = 99;
const EXPECTED_REWRITE_ROWS = 32;
const EXPECTED_OVERSIZED_ROWS = 7;

interface UnsafeAdjudicationPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-unsafe-trace-adjudication-plan";
  proposedReviewId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  requiresOperatorDecision: true;
  captureSafetyPlanDigest: string;
  captureSafetyPreviewSha256: string;
  source: CompanionDispositionSourceV1;
  counts: { soft_archive_proposal: number; bounded_rewrite_hold: number };
  reasons: Record<string, number>;
  summary: {
    targetRows: number;
    softArchiveProposalRows: number;
    boundedRewriteHoldRows: number;
    oversizedHoldRows: number;
    mutationReadyRows: 0;
  };
  rows: CandidateUnsafeTraceAdjudicationRowV1[];
  planDigest: string;
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

export interface LiveCandidateUnsafeTraceDispositionPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-unsafe-trace-disposition-plan";
  createdAt: string;
  proposedDispositionId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  emitsContentDigests: true;
  softArchiveProposalRows: 99;
  boundedRewriteDesignRows: 32;
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
  adjudicationPlanSha256: string;
  source: CompanionDispositionSourceV1;
  summary: ReturnType<typeof planCandidateUnsafeTraceDispositionV1>["summary"] & { liveBindingMismatches: 0 };
  archiveRows: ReturnType<typeof planCandidateUnsafeTraceDispositionV1>["archiveRows"];
  rewriteDesigns: ReturnType<typeof planCandidateUnsafeTraceDispositionV1>["rewriteDesigns"];
  planDigest: string;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function privateJson<T>(path: string): { value: T; sha256: string } {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("unsafe trace disposition input must be a non-empty owner-only file");
  }
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString("utf8")) as T, sha256: hash(bytes) };
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

function validateAdjudication(value: UnsafeAdjudicationPlanV1): UnsafeAdjudicationPlanV1 {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-unsafe-trace-adjudication-plan"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.authorizesContentRewrite !== false
    || value.authorizesSoftArchive !== false
    || value.authorizesHardDelete !== false
    || value.authorizesLifecycleMutation !== false
    || value.authorizesVerificationMutation !== false
    || value.requiresOperatorDecision !== true
    || value.summary?.targetRows !== EXPECTED_TARGET_ROWS
    || value.summary.softArchiveProposalRows !== EXPECTED_ARCHIVE_ROWS
    || value.summary.boundedRewriteHoldRows !== EXPECTED_REWRITE_ROWS
    || value.summary.oversizedHoldRows !== EXPECTED_OVERSIZED_ROWS
    || value.summary.mutationReadyRows !== 0
    || value.counts?.soft_archive_proposal !== EXPECTED_ARCHIVE_ROWS
    || value.counts.bounded_rewrite_hold !== EXPECTED_REWRITE_ROWS
    || !Array.isArray(value.rows)
    || value.rows.length !== EXPECTED_TARGET_ROWS
    || new Set(value.rows.map((row) => row.itemIdSha256)).size !== EXPECTED_TARGET_ROWS
  ) throw new Error("unsafe trace disposition adjudication is invalid or outside the exact lane");
  const core = {
    proposedReviewId: value.proposedReviewId,
    captureSafetyPlanDigest: value.captureSafetyPlanDigest,
    captureSafetyPreviewSha256: value.captureSafetyPreviewSha256,
    source: value.source,
    counts: value.counts,
    reasons: value.reasons,
    summary: value.summary,
    rows: value.rows,
  };
  if (hash(JSON.stringify(core)) !== value.planDigest) {
    throw new Error("unsafe trace disposition adjudication digest is invalid");
  }
  return value;
}

function candidateRows(db: DatabaseSync): CandidateRowV1[] {
  return db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,
    i.lifecycle,i.verification,l.metadata,
    COALESCE((SELECT s.evidence_json FROM memory_sources s
      WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
    FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
    WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all() as CandidateRowV1[];
}

function assertLiveMatch(row: CandidateRowV1, planned: CandidateUnsafeTraceAdjudicationRowV1): void {
  const metadata = parseRecord(row.metadata);
  const evidence = parseRecord(row.evidence_json);
  const receipt = evidence.sourceLineageReceiptV1;
  const safety = evaluateCaptureSafety(row.content);
  if (row.lifecycle !== "candidate"
    || row.verification !== "unverified"
    || hash(row.item_id) !== planned.itemIdSha256
    || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
    || hash(row.content) !== planned.contentDigest
    || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
    || row.category !== planned.category
    || safety.allowed !== false
    || safety.reason !== "operational-trace"
    || safety.pattern !== planned.captureSafetyPattern
    || !validateSourceLineageReceiptV1(receipt, classification(metadata, evidence))
    || hash(JSON.stringify(receipt)) !== planned.sourceLineageReceiptDigest) {
    throw new Error("unsafe trace disposition live target no longer matches the adjudication");
  }
}

export function createLiveCandidateUnsafeTraceDispositionPlanV1(input: {
  sourcePath: string;
  adjudicationPlanPath: string;
  proposedDispositionId: string;
  now?: () => Date;
}): LiveCandidateUnsafeTraceDispositionPlanV1 {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedDispositionId)) {
    throw new Error("unsafe trace disposition id is invalid");
  }
  const loaded = privateJson<UnsafeAdjudicationPlanV1>(input.adjudicationPlanPath);
  const adjudication = validateAdjudication(loaded.value);
  const disposition = planCandidateUnsafeTraceDispositionV1(adjudication.rows);
  if (disposition.summary.softArchiveRows !== EXPECTED_ARCHIVE_ROWS
    || disposition.summary.boundedRewriteRows !== EXPECTED_REWRITE_ROWS
    || disposition.summary.oversizedSegmentationRows !== EXPECTED_OVERSIZED_ROWS
    || disposition.summary.semanticExtractionRows !== EXPECTED_REWRITE_ROWS - EXPECTED_OVERSIZED_ROWS) {
    throw new Error("unsafe trace disposition design does not cover the exact 99/32 lane");
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const source = companionDispositionSourceStateV1(db);
    if (!sameCompanionDispositionSourceV1(source, adjudication.source)) {
      throw new Error("live source no longer matches the unsafe trace adjudication");
    }
    const candidates = candidateRows(db);
    if (candidates.length !== source.candidateRows) {
      throw new Error("unsafe trace disposition candidate mapping is incomplete");
    }
    const byHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
    for (const planned of adjudication.rows) {
      const live = byHash.get(planned.itemIdSha256);
      if (!live) throw new Error("unsafe trace disposition target mapping is incomplete");
      assertLiveMatch(live, planned);
    }
    if (!sameCompanionDispositionSourceV1(source, companionDispositionSourceStateV1(db))) {
      throw new Error("live source changed during unsafe trace disposition planning");
    }
    const summary = { ...disposition.summary, liveBindingMismatches: 0 as const };
    const core = {
      proposedDispositionId: input.proposedDispositionId,
      adjudicationPlanDigest: adjudication.planDigest,
      adjudicationPlanSha256: loaded.sha256,
      source,
      summary,
      archiveRows: disposition.archiveRows,
      rewriteDesigns: disposition.rewriteDesigns,
    };
    return {
      schemaVersion: 1,
      phase: "clawlore-candidate-unsafe-trace-disposition-plan",
      createdAt: (input.now?.() ?? new Date()).toISOString(),
      proposedDispositionId: input.proposedDispositionId,
      readOnly: true,
      queryOnly: true,
      emitsMemoryContent: false,
      emitsTranscriptContent: false,
      emitsRawIdentifiers: false,
      emitsContentDigests: true,
      softArchiveProposalRows: EXPECTED_ARCHIVE_ROWS,
      boundedRewriteDesignRows: EXPECTED_REWRITE_ROWS,
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

export function validateLiveCandidateUnsafeTraceDispositionPlanV1(
  value: LiveCandidateUnsafeTraceDispositionPlanV1,
  expectedDigest?: string,
): LiveCandidateUnsafeTraceDispositionPlanV1 {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-unsafe-trace-disposition-plan"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.emitsContentDigests !== true
    || value.softArchiveProposalRows !== EXPECTED_ARCHIVE_ROWS
    || value.boundedRewriteDesignRows !== EXPECTED_REWRITE_ROWS
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
    || value.summary?.targetRows !== EXPECTED_TARGET_ROWS
    || value.summary.softArchiveRows !== EXPECTED_ARCHIVE_ROWS
    || value.summary.boundedRewriteRows !== EXPECTED_REWRITE_ROWS
    || value.summary.oversizedSegmentationRows !== EXPECTED_OVERSIZED_ROWS
    || value.summary.semanticExtractionRows !== EXPECTED_REWRITE_ROWS - EXPECTED_OVERSIZED_ROWS
    || value.summary.mutationReadyRows !== 0
    || value.summary.liveBindingMismatches !== 0
    || !Array.isArray(value.archiveRows)
    || value.archiveRows.length !== EXPECTED_ARCHIVE_ROWS
    || !Array.isArray(value.rewriteDesigns)
    || value.rewriteDesigns.length !== EXPECTED_REWRITE_ROWS
    || new Set(value.archiveRows.map((row) => row.itemIdSha256)).size !== EXPECTED_ARCHIVE_ROWS
    || new Set(value.rewriteDesigns.map((row) => row.itemIdSha256)).size !== EXPECTED_REWRITE_ROWS
    || value.archiveRows.some((row) => row.proposedAction !== "soft_archive_under_separate_exact_apply"
      || row.mutationReady !== false || row.proposedLifecycle !== "archived"
      || row.proposedVerification !== "unverified")
    || value.rewriteDesigns.some((row) => row.proposedAction !== "hold_for_separate_bounded_rewrite_proposal"
      || row.mutationReady !== false || row.proposedLifecycle !== "candidate"
      || row.proposedVerification !== "unverified" || row.removeCommandAndToolEnvelope !== true
      || row.requireCaptureSafetyPass !== true || row.requireCorpusDeduplication !== true)
    || value.archiveRows.some((row) => value.rewriteDesigns.some((rewrite) => rewrite.itemIdSha256 === row.itemIdSha256))
    || !isDigest(value.planDigest)
    || (expectedDigest !== undefined && value.planDigest !== expectedDigest)
  ) throw new Error("unsafe trace disposition plan is invalid or outside the exact 99/32 lane");
  const core = {
    proposedDispositionId: value.proposedDispositionId,
    adjudicationPlanDigest: value.adjudicationPlanDigest,
    adjudicationPlanSha256: value.adjudicationPlanSha256,
    source: value.source,
    summary: value.summary,
    archiveRows: value.archiveRows,
    rewriteDesigns: value.rewriteDesigns,
  };
  if (hash(JSON.stringify(core)) !== value.planDigest) {
    throw new Error("unsafe trace disposition plan digest is invalid");
  }
  return value;
}
