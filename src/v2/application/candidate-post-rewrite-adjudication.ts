import type { CandidateContentQualityReviewRowV1 } from "./candidate-content-quality-review.js";

export type CandidatePostRewriteDispositionV1 =
  | "propose_soft_archive"
  | "retain_candidate_for_verification"
  | "hold_for_bounded_rewrite";

export type CandidatePostRewriteDecisionBasisV1 =
  | "transient_conversation"
  | "covered_by_canonical_policy"
  | "volatile_runtime_snapshot"
  | "semantic_redundancy"
  | "durable_content_requires_verification"
  | "durable_preference_requires_verification"
  | "durable_decision_requires_verification"
  | "durable_content_requires_rewrite";

export interface CandidatePostRewriteOperatorDecisionV1 {
  itemIdSha256: string;
  disposition: CandidatePostRewriteDispositionV1;
  basis: CandidatePostRewriteDecisionBasisV1;
  evidenceDigest: string;
}

export interface CandidatePostRewriteAdjudicationRowV1 {
  itemIdSha256: string;
  currentRevisionIdSha256: string;
  contentDigest: string;
  normalizedContentDigest: string;
  sourceLineageReceiptDigest: string;
  category: string;
  sourceLane: "exact_duplicate_review" | "manual_semantic_review";
  disposition: CandidatePostRewriteDispositionV1;
  basis: CandidatePostRewriteDecisionBasisV1;
  evidenceDigest: string;
  proposedNextAction:
    | "soft_archive_under_separate_exact_apply"
    | "retain_candidate_until_evidence_complete"
    | "bounded_rewrite_under_separate_review";
  mutationReady: false;
  proposedLifecycle: "candidate";
  proposedVerification: "unverified";
}

export interface CandidatePostRewriteAdjudicationV1 {
  summary: {
    targetRows: 58;
    exactDuplicateRows: 2;
    manualSemanticRows: 56;
    proposedSoftArchiveRows: number;
    retainedForVerificationRows: number;
    boundedRewriteHoldRows: number;
    mutationReadyRows: 0;
  };
  rows: CandidatePostRewriteAdjudicationRowV1[];
}

const EXPECTED_TARGET_ROWS = 58;
const EXPECTED_DUPLICATE_ROWS = 2;

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validPair(decision: CandidatePostRewriteOperatorDecisionV1): boolean {
  if (decision.disposition === "propose_soft_archive") {
    return [
      "transient_conversation",
      "covered_by_canonical_policy",
      "volatile_runtime_snapshot",
      "semantic_redundancy",
    ].includes(decision.basis);
  }
  if (decision.disposition === "retain_candidate_for_verification") {
    return [
      "durable_content_requires_verification",
      "durable_preference_requires_verification",
      "durable_decision_requires_verification",
    ].includes(decision.basis);
  }
  return decision.disposition === "hold_for_bounded_rewrite"
    && decision.basis === "durable_content_requires_rewrite";
}

export function adjudicateCandidatePostRewriteReviewV1(
  rows: CandidateContentQualityReviewRowV1[],
  decisions: CandidatePostRewriteOperatorDecisionV1[],
): CandidatePostRewriteAdjudicationV1 {
  if (
    rows.length !== EXPECTED_TARGET_ROWS
    || rows.filter((row) => row.lane === "exact_duplicate_review").length !== EXPECTED_DUPLICATE_ROWS
    || rows.filter((row) => row.lane === "manual_semantic_review").length
      !== EXPECTED_TARGET_ROWS - EXPECTED_DUPLICATE_ROWS
    || rows.some((row) => !["exact_duplicate_review", "manual_semantic_review"].includes(row.lane)
      || row.captureSafety.allowed !== true
      || row.postLifecycle !== "candidate"
      || row.postVerification !== "unverified")
  ) throw new Error("post-rewrite adjudication requires the exact 2 duplicate / 56 semantic safe lanes");

  const rowByHash = new Map<string, CandidateContentQualityReviewRowV1>();
  for (const row of rows) {
    for (const digest of [
      row.itemIdSha256,
      row.currentRevisionIdSha256,
      row.contentDigest,
      row.normalizedContentDigest,
      row.sourceLineageReceiptDigest,
    ]) if (!isDigest(digest)) throw new Error("post-rewrite adjudication row digest is invalid");
    if (rowByHash.has(row.itemIdSha256)) throw new Error("post-rewrite adjudication rows must be unique");
    rowByHash.set(row.itemIdSha256, row);
  }

  const decisionByHash = new Map<string, CandidatePostRewriteOperatorDecisionV1>();
  for (const decision of decisions) {
    if (!isDigest(decision.itemIdSha256) || !isDigest(decision.evidenceDigest) || !validPair(decision)) {
      throw new Error("post-rewrite operator decision is invalid");
    }
    if (decisionByHash.has(decision.itemIdSha256)) {
      throw new Error("post-rewrite operator decisions must be unique");
    }
    decisionByHash.set(decision.itemIdSha256, decision);
  }
  if (
    decisionByHash.size !== rowByHash.size
    || [...rowByHash.keys()].some((itemHash) => !decisionByHash.has(itemHash))
    || [...decisionByHash.keys()].some((itemHash) => !rowByHash.has(itemHash))
  ) throw new Error("post-rewrite operator decisions must cover the exact review set");

  const adjudicated = rows.map((row): CandidatePostRewriteAdjudicationRowV1 => {
    const decision = decisionByHash.get(row.itemIdSha256)!;
    return {
      itemIdSha256: row.itemIdSha256,
      currentRevisionIdSha256: row.currentRevisionIdSha256,
      contentDigest: row.contentDigest,
      normalizedContentDigest: row.normalizedContentDigest,
      sourceLineageReceiptDigest: row.sourceLineageReceiptDigest,
      category: row.category,
      sourceLane: row.lane as "exact_duplicate_review" | "manual_semantic_review",
      disposition: decision.disposition,
      basis: decision.basis,
      evidenceDigest: decision.evidenceDigest,
      proposedNextAction: decision.disposition === "propose_soft_archive"
        ? "soft_archive_under_separate_exact_apply"
        : decision.disposition === "hold_for_bounded_rewrite"
          ? "bounded_rewrite_under_separate_review"
          : "retain_candidate_until_evidence_complete",
      mutationReady: false,
      proposedLifecycle: "candidate",
      proposedVerification: "unverified",
    };
  }).sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));

  return {
    summary: {
      targetRows: EXPECTED_TARGET_ROWS,
      exactDuplicateRows: EXPECTED_DUPLICATE_ROWS,
      manualSemanticRows: (EXPECTED_TARGET_ROWS - EXPECTED_DUPLICATE_ROWS) as 56,
      proposedSoftArchiveRows: adjudicated.filter((row) => row.disposition === "propose_soft_archive").length,
      retainedForVerificationRows: adjudicated
        .filter((row) => row.disposition === "retain_candidate_for_verification").length,
      boundedRewriteHoldRows: adjudicated.filter((row) => row.disposition === "hold_for_bounded_rewrite").length,
      mutationReadyRows: 0,
    },
    rows: adjudicated,
  };
}
