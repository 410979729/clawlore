import { createHash } from "node:crypto";
import type { CandidatePromotionPlanV1 } from "./candidate-promotion-policy.js";

const SHA256_RE = /^[a-f0-9]{64}$/i;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;
export const PHASE7G_LEGACY_SEARCH_FIELD_ALLOWLIST_V1 = [
  "l0_abstract",
  "l1_overview",
  "l2_content",
  "keywords",
  "entities",
  "tags",
  "category",
  "tier",
] as const;

export interface Phase7GSnapshotEvidenceV1 {
  receiptSha256: string;
  createdAt: string;
  sourceLogicalDigest: string;
  sourceRows: number;
  candidateRows: number;
  restoreVerified: boolean;
  sourceUnchanged: boolean;
  plaintextResidueFiles: number;
}

export interface CompatibilityBackfillPlanEvidenceV1 {
  schemaVersion: 1;
  phase: "clawlore-compatibility-backfill-plan";
  readOnly: true;
  emitsMemoryContent: false;
  sourceUnchanged: true;
  sourceRows: number;
  v2Rows: number;
  existingProjectionRows: number;
  expectedProjectionRows: number;
  mappingMismatchRows: number;
  rawLegacyMetadataCopied: false;
  bootstrapSource: "memory_truth.metadata_text";
  indexedLegacyMetadataFields: string[];
  planDigest: string;
  authorizesLiveMutation: false;
}

export interface Phase7GControlBundleV1 {
  schemaVersion: 1;
  phase: "clawlore-phase7g-rollout-controls";
  readOnly: true;
  emitsMemoryContent: false;
  status: "ready" | "blocked";
  blockers: string[];
  snapshot: {
    receiptSha256: string;
    sourceLogicalDigest: string;
    sourceRows: number;
    candidateRows: number;
    ageSeconds: number;
    maximumAgeSeconds: number;
    restoreVerified: boolean;
    sourceUnchanged: boolean;
    plaintextResidueFiles: number;
  };
  plans: {
    compatibilityBackfill: {
      rolloutId: string;
      mode: "compatibility-backfill";
      planDigest: string;
    };
    candidatePromotion: {
      rolloutId: string;
      mode: "candidate-promotion";
      planDigest: string;
      eligibleRows: number;
    };
  };
  isolation: {
    compatibilityPlanCannotPromoteCandidates: true;
    promotionPlanCannotCreateProjection: true;
  };
  authorizesCompatibilityBackfill: false;
  authorizesCandidatePromotion: false;
  authorizesContextEngine: false;
  authorizesPromptMutation: false;
  authorizesFinalRecallCutover: false;
  controlDigest: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function validCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validRolloutId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{7,127}$/i.test(value);
}

function exactSearchAllowlist(values: string[]): boolean {
  return values.length === PHASE7G_LEGACY_SEARCH_FIELD_ALLOWLIST_V1.length
    && values.every((value, index) => value === PHASE7G_LEGACY_SEARCH_FIELD_ALLOWLIST_V1[index]);
}

export function buildPhase7GControlBundleV1(input: {
  compatibilityRolloutId: string;
  promotionRolloutId: string;
  snapshot: Phase7GSnapshotEvidenceV1;
  compatibilityPlan: CompatibilityBackfillPlanEvidenceV1;
  promotionPlan: CandidatePromotionPlanV1;
  now?: () => Date;
  maximumSnapshotAgeSeconds?: number;
}): Phase7GControlBundleV1 {
  const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
  if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
    throw new Error("maximum snapshot age must be a positive integer");
  }
  if (!validRolloutId(input.compatibilityRolloutId) || !validRolloutId(input.promotionRolloutId)) {
    throw new Error("phase 7G rollout ids are invalid");
  }
  if (input.compatibilityRolloutId === input.promotionRolloutId) {
    throw new Error("compatibility and promotion rollout ids must be distinct");
  }

  const blockers: string[] = [];
  const snapshotTime = Date.parse(input.snapshot.createdAt);
  const now = (input.now?.() ?? new Date()).getTime();
  const ageSeconds = Number.isFinite(snapshotTime) ? Math.max(0, Math.floor((now - snapshotTime) / 1000)) : -1;
  if (!validDigest(input.snapshot.receiptSha256)) blockers.push("snapshot_receipt_digest_invalid");
  if (!validDigest(input.snapshot.sourceLogicalDigest)) blockers.push("snapshot_source_digest_invalid");
  if (!validCount(input.snapshot.sourceRows)) blockers.push("snapshot_source_rows_invalid");
  if (!validCount(input.snapshot.candidateRows) || input.snapshot.candidateRows > input.snapshot.sourceRows) {
    blockers.push("snapshot_candidate_rows_invalid");
  }
  if (!Number.isFinite(snapshotTime) || snapshotTime > now) blockers.push("snapshot_timestamp_invalid");
  else if (ageSeconds > maximumAgeSeconds) blockers.push("fresh_encrypted_snapshot_required");
  if (input.snapshot.restoreVerified !== true) blockers.push("snapshot_restore_verification_missing");
  if (input.snapshot.sourceUnchanged !== true) blockers.push("snapshot_source_changed");
  if (input.snapshot.plaintextResidueFiles !== 0) blockers.push("snapshot_plaintext_residue_present");

  const compatibility = input.compatibilityPlan;
  if (
    compatibility.schemaVersion !== 1
    || compatibility.phase !== "clawlore-compatibility-backfill-plan"
    || compatibility.readOnly !== true
    || compatibility.emitsMemoryContent !== false
    || compatibility.sourceUnchanged !== true
    || compatibility.authorizesLiveMutation !== false
    || compatibility.bootstrapSource !== "memory_truth.metadata_text"
  ) blockers.push("compatibility_plan_contract_invalid");
  if (!validDigest(compatibility.planDigest)) blockers.push("compatibility_plan_digest_invalid");
  if (
    !validCount(compatibility.sourceRows)
    || !validCount(compatibility.v2Rows)
    || !validCount(compatibility.existingProjectionRows)
    || !validCount(compatibility.expectedProjectionRows)
    || !validCount(compatibility.mappingMismatchRows)
  ) blockers.push("compatibility_plan_counts_invalid");
  if (
    compatibility.sourceRows !== input.snapshot.sourceRows
    || compatibility.v2Rows !== compatibility.sourceRows
    || compatibility.expectedProjectionRows !== compatibility.sourceRows
    || compatibility.mappingMismatchRows !== 0
  ) blockers.push("compatibility_projection_mapping_incomplete");
  if (compatibility.existingProjectionRows !== 0) blockers.push("compatibility_projection_already_exists");
  if (compatibility.rawLegacyMetadataCopied !== false) blockers.push("raw_legacy_metadata_copy_forbidden");
  if (!exactSearchAllowlist(compatibility.indexedLegacyMetadataFields)) {
    blockers.push("compatibility_index_allowlist_invalid");
  }

  const promotion = input.promotionPlan;
  if (
    promotion.schemaVersion !== 1
    || promotion.phase !== "clawlore-candidate-promotion-plan"
    || promotion.readOnly !== true
    || promotion.emitsItemIds !== false
    || promotion.automaticPromotionRows !== 0
    || promotion.authorizesLiveMutation !== false
  ) blockers.push("promotion_plan_contract_invalid");
  if (!validDigest(promotion.planDigest)) blockers.push("promotion_plan_digest_invalid");
  const promotionCount = Object.values(promotion.counts).reduce((sum, count) => sum + count, 0);
  if (promotionCount !== promotion.rows.length) blockers.push("promotion_plan_counts_inconsistent");
  if (
    promotionCount !== input.snapshot.candidateRows
    || promotion.counts.preserve_archived !== 0
  ) blockers.push("promotion_plan_candidate_coverage_incomplete");

  const snapshot = {
    receiptSha256: input.snapshot.receiptSha256,
    sourceLogicalDigest: input.snapshot.sourceLogicalDigest,
    sourceRows: input.snapshot.sourceRows,
    candidateRows: input.snapshot.candidateRows,
    ageSeconds,
    maximumAgeSeconds,
    restoreVerified: input.snapshot.restoreVerified,
    sourceUnchanged: input.snapshot.sourceUnchanged,
    plaintextResidueFiles: input.snapshot.plaintextResidueFiles,
  };
  const plans = {
    compatibilityBackfill: {
      rolloutId: input.compatibilityRolloutId,
      mode: "compatibility-backfill" as const,
      planDigest: compatibility.planDigest,
    },
    candidatePromotion: {
      rolloutId: input.promotionRolloutId,
      mode: "candidate-promotion" as const,
      planDigest: promotion.planDigest,
      eligibleRows: promotion.counts.eligible_for_promotion,
    },
  };
  const controlDigest = hash(JSON.stringify({ snapshot, plans, blockers }));
  return {
    schemaVersion: 1,
    phase: "clawlore-phase7g-rollout-controls",
    readOnly: true,
    emitsMemoryContent: false,
    status: blockers.length === 0 ? "ready" : "blocked",
    blockers,
    snapshot,
    plans,
    isolation: {
      compatibilityPlanCannotPromoteCandidates: true,
      promotionPlanCannotCreateProjection: true,
    },
    authorizesCompatibilityBackfill: false,
    authorizesCandidatePromotion: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecallCutover: false,
    controlDigest,
  };
}
