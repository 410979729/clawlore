import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { evaluateCaptureSafety } from "../../capture-safety.js";
import {
  normalizeCandidateContentV1,
  validateSourceLineageReceiptV1,
} from "../application/candidate-content-quality-review.js";
import { adjudicateCandidateUnsafeTracesV1 } from "../application/candidate-unsafe-trace-adjudication.js";
import type { CandidateCaptureSafetyReviewRowV1 } from "../application/candidate-capture-safety-review.js";
import type { LiveCandidateCaptureSafetyReviewPlanV1 } from "./live-candidate-capture-safety-review.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;

interface CandidateRow {
  item_id: string;
  current_revision_id: string;
  content: string;
  category: string;
  lifecycle: "candidate";
  verification: "unverified";
  metadata: string;
  evidence_json: string;
}

export interface LiveCandidateUnsafeTraceAdjudicationPlanV1 {
  schemaVersion: 1;
  phase: "clawlore-candidate-unsafe-trace-adjudication-plan";
  createdAt: string;
  proposedReviewId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  emitsContentDigests: true;
  authorizesContentRewrite: false;
  authorizesSoftArchive: false;
  authorizesHardDelete: false;
  authorizesLifecycleMutation: false;
  authorizesVerificationMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  requiresOperatorDecision: true;
  captureSafetyPlanDigest: string;
  captureSafetyPreviewSha256: string;
  source: LiveCandidateCaptureSafetyReviewPlanV1["source"];
  counts: ReturnType<typeof adjudicateCandidateUnsafeTracesV1>["counts"];
  reasons: ReturnType<typeof adjudicateCandidateUnsafeTracesV1>["reasons"];
  summary: ReturnType<typeof adjudicateCandidateUnsafeTracesV1>["summary"];
  rows: ReturnType<typeof adjudicateCandidateUnsafeTracesV1>["rows"];
  planDigest: string;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateJson<T>(path: string): { value: T; sha256: string } {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("unsafe trace adjudication input must be a non-empty owner-only file");
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

function validateCaptureControl(plan: LiveCandidateCaptureSafetyReviewPlanV1): void {
  const core = {
    proposedReviewId: plan.proposedReviewId,
    contentQualityPlanDigest: plan.contentQualityPlanDigest,
    contentQualityPreviewSha256: plan.contentQualityPreviewSha256,
    source: plan.source,
    counts: plan.counts,
    summary: plan.summary,
    rows: plan.rows,
  };
  if (plan?.schemaVersion !== 1
    || plan.phase !== "clawlore-candidate-capture-safety-review-plan"
    || plan.readOnly !== true
    || plan.queryOnly !== true
    || plan.emitsMemoryContent !== false
    || plan.emitsTranscriptContent !== false
    || plan.emitsRawIdentifiers !== false
    || plan.authorizesContentRewrite !== false
    || plan.authorizesSoftArchive !== false
    || plan.authorizesHardDelete !== false
    || plan.authorizesLifecycleMutation !== false
    || plan.authorizesVerificationMutation !== false
    || plan.requiresOperatorDecision !== true
    || plan.summary.targetRows <= 0
    || plan.summary.targetRows !== plan.rows.length
    || hash(JSON.stringify(core)) !== plan.planDigest) {
    throw new Error("unsafe trace adjudication capture-safety control is invalid");
  }
}

function assertLiveMatch(row: CandidateRow, planned: CandidateCaptureSafetyReviewRowV1): void {
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
    throw new Error("unsafe trace adjudication live target no longer matches capture-safety control");
  }
}

export function createLiveCandidateUnsafeTraceAdjudicationPlanV1(input: {
  sourcePath: string;
  captureSafetyPreviewPath: string;
  proposedReviewId: string;
  now?: () => Date;
}): LiveCandidateUnsafeTraceAdjudicationPlanV1 {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedReviewId)) {
    throw new Error("proposed unsafe trace adjudication id is invalid");
  }
  const loaded = privateJson<LiveCandidateCaptureSafetyReviewPlanV1>(input.captureSafetyPreviewPath);
  validateCaptureControl(loaded.value);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const rows = db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,
      i.lifecycle,i.verification,l.metadata,
      COALESCE((SELECT s.evidence_json FROM memory_sources s
        WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
      FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all() as CandidateRow[];
    if (rows.length !== loaded.value.source.candidateRows) {
      throw new Error("unsafe trace adjudication candidate mapping is incomplete");
    }
    const liveByHash = new Map(rows.map((row) => [hash(row.item_id), row]));
    const inputs = loaded.value.rows.map((planned) => {
      const live = liveByHash.get(planned.itemIdSha256);
      if (!live) throw new Error("unsafe trace adjudication target mapping is incomplete");
      assertLiveMatch(live, planned);
      return { review: planned, content: live.content };
    });
    const assessment = adjudicateCandidateUnsafeTracesV1(inputs);
    const core = {
      proposedReviewId: input.proposedReviewId,
      captureSafetyPlanDigest: loaded.value.planDigest,
      captureSafetyPreviewSha256: loaded.sha256,
      source: loaded.value.source,
      counts: assessment.counts,
      reasons: assessment.reasons,
      summary: assessment.summary,
      rows: assessment.rows,
    };
    return {
      schemaVersion: 1,
      phase: "clawlore-candidate-unsafe-trace-adjudication-plan",
      createdAt: (input.now?.() ?? new Date()).toISOString(),
      proposedReviewId: input.proposedReviewId,
      readOnly: true,
      queryOnly: true,
      emitsMemoryContent: false,
      emitsTranscriptContent: false,
      emitsRawIdentifiers: false,
      emitsContentDigests: true,
      authorizesContentRewrite: false,
      authorizesSoftArchive: false,
      authorizesHardDelete: false,
      authorizesLifecycleMutation: false,
      authorizesVerificationMutation: false,
      authorizesContextEngine: false,
      authorizesPromptMutation: false,
      authorizesFinalRecall: false,
      requiresOperatorDecision: true,
      ...core,
      planDigest: hash(JSON.stringify(core)),
    };
  } finally {
    db.close();
  }
}
