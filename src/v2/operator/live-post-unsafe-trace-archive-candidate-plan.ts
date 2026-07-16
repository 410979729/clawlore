import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  companionDispositionSourceStateV1,
  sameCompanionDispositionSourceV1,
  type CompanionDispositionSourceV1,
} from "./live-candidate-companion-disposition.js";
import {
  validateLiveCandidateUnsafeTraceDispositionPlanV1,
  type LiveCandidateUnsafeTraceDispositionPlanV1,
} from "./live-candidate-unsafe-trace-disposition.js";
import type {
  LiveCandidateUnsafeTraceArchivePostcheckV1,
  LiveCandidateUnsafeTraceArchiveReceiptV1,
} from "./live-candidate-unsafe-trace-archive.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const ARCHIVE_ROWS = 99;
const PROTECTED_REWRITE_ROWS = 32;

interface CandidatePromotionRowV1 {
  itemIdSha256: string;
  disposition: "eligible_for_promotion" | "hold_candidate" | "quarantine" | "preserve_archived";
  reasonCodes: string[];
}

interface CandidatePromotionPlanV1 {
  schemaVersion: 1;
  phase: string;
  readOnly: true;
  emitsItemIds: false;
  authorizesLiveMutation: false;
  automaticPromotionRows: 0;
  counts: Record<CandidatePromotionRowV1["disposition"], number>;
  rows: CandidatePromotionRowV1[];
  planDigest: string;
}

interface PriorCandidatePlanV1 {
  schemaVersion: 1;
  phase: "clawlore-post-assignment-candidate-plan";
  createdAt: string;
  proposedRolloutId: string;
  readOnly: true;
  queryOnly: true;
  emitsMemoryContent: false;
  emitsTranscriptContent: false;
  emitsRawIdentifiers: false;
  source: CompanionDispositionSourceV1 & {
    baselineV1Rows: number;
    unmirroredV1Rows: number;
    missingLegacyRowsForV2: 0;
    candidateBaselineUnchanged: true;
    sourceUnchangedDuringPlan: true;
  };
  candidatePromotionPlan: CandidatePromotionPlanV1;
  decision: {
    eligibleRows: number;
    lifecycleRolloutSelectable: boolean;
    finalRecallCutoverBlockedByUnmirroredV1: boolean;
    automaticPromotionRows: 0;
  };
  authorizesLifecycleMutation: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecall: false;
  liveMutation: {
    evidenceRowsChanged: 0;
    lifecycleRowsChanged: 0;
    verificationRowsChanged: 0;
    addressRowsChanged: 0;
    contextEngineEnabled: false;
    promptMutationEnabled: false;
    finalRecallCutoverEnabled: false;
  };
  [key: string]: unknown;
}

export interface LivePostUnsafeTraceArchiveCandidatePlanV1 extends PriorCandidatePlanV1 {
  unsafeTraceArchiveRebase: {
    rolloutId: string;
    planDigest: string;
    archivePlanSha256: string;
    applyReceiptSha256: string;
    postcheckSha256: string;
    priorBaselineSha256: string;
    archivedCandidateRows: 99;
    protectedRewriteRows: 32;
    preservedCandidateRows: number;
    removedItemIdSha256: string[];
    protectedRewriteItemIdSha256: string[];
  };
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function privateJson<T>(path: string): { value: T; sha256: string } {
  if (process.platform === "win32") preparePrivateFileForRead(path);
  const info = statSync(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("post-unsafe-trace-archive control must be a non-empty owner-only file");
  }
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as T;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("post-unsafe-trace-archive control JSON is invalid");
  }
  return { value, sha256: hash(bytes) };
}

function validatePriorBaseline(value: PriorCandidatePlanV1): void {
  const promotion = value?.candidatePromotionPlan;
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-post-assignment-candidate-plan"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.emitsMemoryContent !== false
    || value.emitsTranscriptContent !== false
    || value.emitsRawIdentifiers !== false
    || value.authorizesLifecycleMutation !== false
    || value.authorizesContextEngine !== false
    || value.authorizesPromptMutation !== false
    || value.authorizesFinalRecall !== false
    || promotion?.schemaVersion !== 1
    || promotion.readOnly !== true
    || promotion.emitsItemIds !== false
    || promotion.authorizesLiveMutation !== false
    || promotion.automaticPromotionRows !== 0
    || !hasDigest(promotion.planDigest)
    || !Array.isArray(promotion.rows)
    || hash(JSON.stringify(promotion.rows)) !== promotion.planDigest
    || promotion.rows.length !== value.source.candidateRows
    || new Set(promotion.rows.map((row) => row.itemIdSha256)).size !== promotion.rows.length
    || value.decision.eligibleRows !== 0
    || value.decision.lifecycleRolloutSelectable !== false
    || value.decision.automaticPromotionRows !== 0
  ) throw new Error("prior candidate baseline is invalid or mutation-capable");
}

function validateApply(
  value: LiveCandidateUnsafeTraceArchiveReceiptV1,
  plan: LiveCandidateUnsafeTraceDispositionPlanV1,
  planSha256: string,
): void {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-unsafe-trace-soft-archive-live-apply"
    || value.status !== "applied"
    || value.planDigest !== plan.planDigest
    || value.planSha256 !== planSha256
    || value.archive.targetRows !== ARCHIVE_ROWS
    || value.archive.candidateRowsArchived !== ARCHIVE_ROWS
    || value.archive.protectedRewriteRows !== PROTECTED_REWRITE_ROWS
    || value.archive.protectedRewriteRowsChanged !== 0
    || value.archive.currentContentRowsChanged !== 0
    || value.archive.currentVerificationRowsChanged !== 0
    || value.archive.addressRowsChanged !== 0
    || value.archive.aclRowsChanged !== 0
    || value.archive.nonTargetRowsChanged !== 0
    || Object.values(value.projections).some((count) => count !== 0)
    || value.database.integrity !== "ok"
    || value.database.foreignKeyViolations !== 0
    || value.runtime.contextEngineEnabled !== false
    || value.runtime.promptMutationEnabled !== false
    || value.runtime.finalRecallCutoverEnabled !== false
  ) throw new Error("unsafe trace archive apply control is invalid");
}

function validatePostcheck(
  value: LiveCandidateUnsafeTraceArchivePostcheckV1,
  plan: LiveCandidateUnsafeTraceDispositionPlanV1,
  apply: LiveCandidateUnsafeTraceArchiveReceiptV1,
  planSha256: string,
  applySha256: string,
): void {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-unsafe-trace-soft-archive-postcheck"
    || value.status !== "pass"
    || value.rolloutId !== apply.rolloutId
    || value.planDigest !== plan.planDigest
    || value.planSha256 !== planSha256
    || value.applyReceiptSha256 !== applySha256
    || !sameCompanionDispositionSourceV1(value.source, apply.sourceAfter)
    || value.targetBinding.archivedRows !== ARCHIVE_ROWS
    || value.targetBinding.protectedRewriteRows !== PROTECTED_REWRITE_ROWS
    || value.targetBinding.protectedRewriteRowsChanged !== 0
    || value.targetBinding.validDispositionReceiptRows !== ARCHIVE_ROWS
    || value.targetBinding.supersedesRelationRows !== ARCHIVE_ROWS
    || value.targetBinding.archivedEventRows !== ARCHIVE_ROWS
    || value.targetBinding.projectionBindingRows !== ARCHIVE_ROWS
    || value.targetBinding.mismatches !== 0
    || value.database.integrity !== "ok"
    || value.database.foreignKeyViolations !== 0
  ) throw new Error("unsafe trace archive postcheck is invalid or unbound");
}

function promotionCounts(rows: CandidatePromotionRowV1[]): CandidatePromotionPlanV1["counts"] {
  return {
    eligible_for_promotion: rows.filter((row) => row.disposition === "eligible_for_promotion").length,
    hold_candidate: rows.filter((row) => row.disposition === "hold_candidate").length,
    quarantine: rows.filter((row) => row.disposition === "quarantine").length,
    preserve_archived: rows.filter((row) => row.disposition === "preserve_archived").length,
  };
}

export function createLivePostUnsafeTraceArchiveCandidatePlanV1(input: {
  sourcePath: string;
  priorBaselinePath: string;
  archivePlanPath: string;
  applyReceiptPath: string;
  postcheckPath: string;
  planDigest: string;
  proposedRolloutId: string;
  now?: () => Date;
}): LivePostUnsafeTraceArchiveCandidatePlanV1 {
  if (!/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(input.proposedRolloutId)) {
    throw new Error("post-unsafe-trace-archive candidate rollout id is invalid");
  }
  const baseline = privateJson<PriorCandidatePlanV1>(input.priorBaselinePath);
  validatePriorBaseline(baseline.value);
  const plan = privateJson<LiveCandidateUnsafeTraceDispositionPlanV1>(input.archivePlanPath);
  validateLiveCandidateUnsafeTraceDispositionPlanV1(plan.value, input.planDigest);
  const apply = privateJson<LiveCandidateUnsafeTraceArchiveReceiptV1>(input.applyReceiptPath);
  validateApply(apply.value, plan.value, plan.sha256);
  const postcheck = privateJson<LiveCandidateUnsafeTraceArchivePostcheckV1>(input.postcheckPath);
  validatePostcheck(postcheck.value, plan.value, apply.value, plan.sha256, apply.sha256);
  if (!sameCompanionDispositionSourceV1(baseline.value.source, apply.value.sourceBefore)) {
    throw new Error("prior candidate baseline does not match unsafe trace archive pre-state");
  }
  const removed = [...new Set(plan.value.archiveRows.map((row) => row.itemIdSha256))].sort();
  const protectedRewrite = [...new Set(plan.value.rewriteDesigns.map((row) => row.itemIdSha256))].sort();
  if (removed.length !== ARCHIVE_ROWS || protectedRewrite.length !== PROTECTED_REWRITE_ROWS) {
    throw new Error("unsafe trace archive target hashes are not exact");
  }
  const priorByHash = new Map(baseline.value.candidatePromotionPlan.rows.map((row) => [row.itemIdSha256, row]));
  if ([...removed, ...protectedRewrite].some((itemIdSha256) =>
    priorByHash.get(itemIdSha256)?.disposition !== "hold_candidate")) {
    throw new Error("unsafe trace archive target is outside the prior hold-candidate baseline");
  }
  const rows = baseline.value.candidatePromotionPlan.rows
    .filter((row) => !removed.includes(row.itemIdSha256));
  const remaining = new Set(rows.map((row) => row.itemIdSha256));
  if (protectedRewrite.some((itemIdSha256) => !remaining.has(itemIdSha256))) {
    throw new Error("protected rewrite target is missing after unsafe trace archive");
  }
  const counts = promotionCounts(rows);
  if (
    rows.length !== postcheck.value.source.candidateRows
    || counts.eligible_for_promotion !== 0
    || counts.preserve_archived !== 0
  ) throw new Error("post-unsafe-trace-archive candidate policy counts are invalid");
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const before = companionDispositionSourceStateV1(db);
    if (!sameCompanionDispositionSourceV1(before, postcheck.value.source)) {
      throw new Error("live source no longer matches unsafe trace archive postcheck");
    }
    const liveRows = db.prepare(
      "SELECT item_id FROM memory_items WHERE lifecycle='candidate' ORDER BY item_id",
    ).all() as Array<{ item_id: string }>;
    const liveHashes = liveRows.map((row) => hash(row.item_id)).sort();
    const plannedHashes = rows.map((row) => row.itemIdSha256).sort();
    if (JSON.stringify(liveHashes) !== JSON.stringify(plannedHashes)) {
      throw new Error("live candidate set does not match the unsafe trace archive rebase");
    }
    if (!sameCompanionDispositionSourceV1(before, companionDispositionSourceStateV1(db))) {
      throw new Error("live source changed during query-only unsafe trace archive rebase");
    }
  } finally {
    db.close();
  }
  const candidatePromotionPlan: CandidatePromotionPlanV1 = {
    ...baseline.value.candidatePromotionPlan,
    counts,
    rows,
    planDigest: hash(JSON.stringify(rows)),
  };
  return {
    ...baseline.value,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    proposedRolloutId: input.proposedRolloutId,
    source: {
      ...baseline.value.source,
      ...postcheck.value.source,
      candidateBaselineUnchanged: true,
      sourceUnchangedDuringPlan: true,
    },
    candidatePromotionPlan,
    unsafeTraceArchiveRebase: {
      rolloutId: apply.value.rolloutId,
      planDigest: plan.value.planDigest,
      archivePlanSha256: plan.sha256,
      applyReceiptSha256: apply.sha256,
      postcheckSha256: postcheck.sha256,
      priorBaselineSha256: baseline.sha256,
      archivedCandidateRows: ARCHIVE_ROWS,
      protectedRewriteRows: PROTECTED_REWRITE_ROWS,
      preservedCandidateRows: rows.length,
      removedItemIdSha256: removed,
      protectedRewriteItemIdSha256: protectedRewrite,
    },
    decision: {
      ...baseline.value.decision,
      eligibleRows: 0,
      lifecycleRolloutSelectable: false,
      automaticPromotionRows: 0,
    },
    liveMutation: {
      evidenceRowsChanged: 0,
      lifecycleRowsChanged: 0,
      verificationRowsChanged: 0,
      addressRowsChanged: 0,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
}
