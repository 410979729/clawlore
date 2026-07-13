import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  companionDispositionSourceStateV1,
  sameCompanionDispositionSourceV1,
  type CompanionDispositionSourceV1,
} from "./live-candidate-companion-disposition.js";
import type {
  LiveCandidateDuplicateArchivePlanV1,
  LiveCandidateDuplicateArchivePostcheckV1,
  LiveCandidateDuplicateArchiveReceiptV1,
} from "./live-candidate-duplicate-archive.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;

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
  assignment: Record<string, unknown>;
  delta?: Record<string, unknown>;
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

export interface LivePostDuplicateArchiveCandidatePlanV1 extends PriorCandidatePlanV1 {
  duplicateArchiveRebase: {
    rolloutId: string;
    planDigest: string;
    archivePlanSha256: string;
    applyReceiptSha256: string;
    postcheckSha256: string;
    priorBaselineSha256: string;
    archivedCandidateRows: 14;
    preservedCandidateRows: number;
    removedItemIdSha256: string[];
  };
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function privateJson<T>(path: string): { value: T; sha256: string } {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
    throw new Error("post-duplicate-archive control must be a non-empty owner-only file");
  }
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as T;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("post-duplicate-archive control JSON is invalid");
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

function validateArchivePlan(value: LiveCandidateDuplicateArchivePlanV1): void {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-duplicate-soft-archive-plan"
    || value.readOnly !== true
    || value.queryOnly !== true
    || value.softArchiveProposalRows !== 14
    || value.targetGroups !== 5
    || value.authorizesSoftArchive !== false
    || value.authorizesLifecycleMutation !== false
    || value.requiresFreshEncryptedSnapshot !== true
    || !Array.isArray(value.rows)
    || value.rows.length !== 14
    || !hasDigest(value.planDigest)
  ) throw new Error("duplicate archive plan is invalid for candidate rebase");
  const core = {
    proposedArchiveId: value.proposedArchiveId,
    adjudicationPlanDigest: value.adjudicationPlanDigest,
    adjudicationPlanSha256: value.adjudicationPlanSha256,
    candidateBaselinePlanDigest: value.candidateBaselinePlanDigest,
    candidateBaselineSha256: value.candidateBaselineSha256,
    captureSafetyPlanDigest: value.captureSafetyPlanDigest,
    captureSafetySha256: value.captureSafetySha256,
    source: value.source,
    summary: value.summary,
    groups: value.groups,
    rows: value.rows,
  };
  if (hash(JSON.stringify(core)) !== value.planDigest) throw new Error("duplicate archive plan digest is invalid");
}

function validateApply(
  value: LiveCandidateDuplicateArchiveReceiptV1,
  plan: LiveCandidateDuplicateArchivePlanV1,
  planSha256: string,
): void {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-duplicate-soft-archive-live-apply"
    || value.status !== "applied"
    || value.planDigest !== plan.planDigest
    || value.planSha256 !== planSha256
    || value.archive.targetGroups !== 5
    || value.archive.targetRows !== 14
    || value.archive.candidateRowsArchived !== 14
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
  ) throw new Error("duplicate archive apply control is invalid");
}

function validatePostcheck(
  value: LiveCandidateDuplicateArchivePostcheckV1,
  plan: LiveCandidateDuplicateArchivePlanV1,
  apply: LiveCandidateDuplicateArchiveReceiptV1,
  planSha256: string,
  applySha256: string,
): void {
  if (
    value?.schemaVersion !== 1
    || value.phase !== "clawlore-candidate-duplicate-soft-archive-postcheck"
    || value.status !== "pass"
    || value.rolloutId !== apply.rolloutId
    || value.planDigest !== plan.planDigest
    || value.planSha256 !== planSha256
    || value.applyReceiptSha256 !== applySha256
    || !sameCompanionDispositionSourceV1(value.source, apply.sourceAfter)
    || value.targetBinding.archivedRows !== 14
    || value.targetBinding.archivedGroups !== 5
    || value.targetBinding.validDispositionReceiptRows !== 14
    || value.targetBinding.supersedesRelationRows !== 14
    || value.targetBinding.archivedEventRows !== 14
    || value.targetBinding.projectionBindingRows !== 14
    || value.targetBinding.mismatches !== 0
    || value.database.integrity !== "ok"
    || value.database.foreignKeyViolations !== 0
  ) throw new Error("duplicate archive postcheck is invalid or unbound");
}

function promotionCounts(rows: CandidatePromotionRowV1[]): CandidatePromotionPlanV1["counts"] {
  return {
    eligible_for_promotion: rows.filter((row) => row.disposition === "eligible_for_promotion").length,
    hold_candidate: rows.filter((row) => row.disposition === "hold_candidate").length,
    quarantine: rows.filter((row) => row.disposition === "quarantine").length,
    preserve_archived: rows.filter((row) => row.disposition === "preserve_archived").length,
  };
}

export function createLivePostDuplicateArchiveCandidatePlanV1(input: {
  sourcePath: string;
  priorBaselinePath: string;
  archivePlanPath: string;
  applyReceiptPath: string;
  postcheckPath: string;
  planDigest: string;
  proposedRolloutId: string;
  now?: () => Date;
}): LivePostDuplicateArchiveCandidatePlanV1 {
  if (!/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(input.proposedRolloutId)) {
    throw new Error("post-duplicate-archive candidate rollout id is invalid");
  }
  const loadedBaseline = privateJson<PriorCandidatePlanV1>(input.priorBaselinePath);
  validatePriorBaseline(loadedBaseline.value);
  const loadedPlan = privateJson<LiveCandidateDuplicateArchivePlanV1>(input.archivePlanPath);
  validateArchivePlan(loadedPlan.value);
  if (loadedPlan.value.planDigest !== input.planDigest) throw new Error("duplicate archive plan digest mismatch");
  const loadedApply = privateJson<LiveCandidateDuplicateArchiveReceiptV1>(input.applyReceiptPath);
  validateApply(loadedApply.value, loadedPlan.value, loadedPlan.sha256);
  const loadedPostcheck = privateJson<LiveCandidateDuplicateArchivePostcheckV1>(input.postcheckPath);
  validatePostcheck(
    loadedPostcheck.value,
    loadedPlan.value,
    loadedApply.value,
    loadedPlan.sha256,
    loadedApply.sha256,
  );
  if (!sameCompanionDispositionSourceV1(loadedBaseline.value.source, loadedApply.value.sourceBefore)) {
    throw new Error("prior candidate baseline does not match duplicate archive pre-state");
  }
  const removed = [...new Set(loadedPlan.value.rows.map((row) => row.itemIdSha256))].sort();
  if (removed.length !== 14) throw new Error("duplicate archive target hashes are not exact");
  const priorByHash = new Map(loadedBaseline.value.candidatePromotionPlan.rows.map((row) => [row.itemIdSha256, row]));
  if (removed.some((itemIdSha256) => priorByHash.get(itemIdSha256)?.disposition !== "hold_candidate")) {
    throw new Error("duplicate archive target is outside the prior hold-candidate baseline");
  }
  const rows = loadedBaseline.value.candidatePromotionPlan.rows
    .filter((row) => !removed.includes(row.itemIdSha256));
  const counts = promotionCounts(rows);
  if (
    rows.length !== loadedPostcheck.value.source.candidateRows
    || counts.eligible_for_promotion !== 0
    || counts.preserve_archived !== 0
  ) throw new Error("post-duplicate-archive candidate policy counts are invalid");
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
  };
  const db = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    const before = companionDispositionSourceStateV1(db);
    if (!sameCompanionDispositionSourceV1(before, loadedPostcheck.value.source)) {
      throw new Error("live source no longer matches duplicate archive postcheck");
    }
    const liveRows = db.prepare(
      "SELECT item_id FROM memory_items WHERE lifecycle='candidate' ORDER BY item_id",
    ).all() as Array<{ item_id: string }>;
    const liveHashes = liveRows.map((row) => hash(row.item_id)).sort();
    const plannedHashes = rows.map((row) => row.itemIdSha256).sort();
    if (JSON.stringify(liveHashes) !== JSON.stringify(plannedHashes)) {
      throw new Error("live candidate set does not match the duplicate archive rebase");
    }
    if (!sameCompanionDispositionSourceV1(before, companionDispositionSourceStateV1(db))) {
      throw new Error("live source changed during query-only duplicate archive rebase");
    }
  } finally {
    db.close();
  }
  const candidatePromotionPlan: CandidatePromotionPlanV1 = {
    ...loadedBaseline.value.candidatePromotionPlan,
    counts,
    rows,
    planDigest: hash(JSON.stringify(rows)),
  };
  return {
    ...loadedBaseline.value,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    proposedRolloutId: input.proposedRolloutId,
    source: {
      ...loadedBaseline.value.source,
      ...loadedPostcheck.value.source,
      candidateBaselineUnchanged: true,
      sourceUnchangedDuringPlan: true,
    },
    candidatePromotionPlan,
    duplicateArchiveRebase: {
      rolloutId: loadedApply.value.rolloutId,
      planDigest: loadedPlan.value.planDigest,
      archivePlanSha256: loadedPlan.sha256,
      applyReceiptSha256: loadedApply.sha256,
      postcheckSha256: loadedPostcheck.sha256,
      priorBaselineSha256: loadedBaseline.sha256,
      archivedCandidateRows: 14,
      preservedCandidateRows: rows.length,
      removedItemIdSha256: removed,
    },
    decision: {
      ...loadedBaseline.value.decision,
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
