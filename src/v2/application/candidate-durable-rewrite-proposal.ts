import { createHash } from "node:crypto";
import { evaluateCaptureSafety } from "../../capture-safety.js";
import { normalizeCandidateContentV1 } from "./candidate-content-quality-review.js";
import type { CandidateDuplicateTraceAdjudicationRowV1 } from "./candidate-duplicate-trace-adjudication.js";

export type CandidateDurableRewriteFactKeyV1 =
  | "local_collaboration_control_plane"
  | "memory_capability_boundary"
  | "episode_before_reviewer";

export type CandidateDurableRewriteKnowledgeCoverageV1 =
  | "covered_by_existing_truth"
  | "materially_new_bounded_truth";

export interface CandidateDurableRewriteSpecificationV1 {
  normalizedContentDigest: string;
  expectedGroupSize: number;
  representativeItemIdSha256: string;
  factKey: CandidateDurableRewriteFactKeyV1;
  knowledgeCoverage: CandidateDurableRewriteKnowledgeCoverageV1;
  knowledgeEvidenceDigest: string;
  proposedContent: string;
}

export interface CandidateDurableRewriteGroupV1 {
  normalizedContentDigest: string;
  expectedGroupSize: number;
  representativeItemIdSha256: string;
  companionItemIdSha256: string;
  factKey: CandidateDurableRewriteFactKeyV1;
  category: string;
  knowledgeCoverage: CandidateDurableRewriteKnowledgeCoverageV1;
  knowledgeEvidenceDigest: string;
  proposedContentDigest: string;
  proposedNormalizedContentDigest: string;
  proposedContentLength: number;
  captureSafetyAllowed: true;
  corpusCollisionRows: 0;
  proposedRepresentativeAction: "rewrite_candidate_under_separate_exact_apply";
  proposedCompanionAction: "hold_candidate_until_post_rewrite_dedupe";
}

export interface CandidateDurableRewriteRowV1 {
  itemIdSha256: string;
  currentRevisionIdSha256: string;
  contentDigest: string;
  normalizedContentDigest: string;
  sourceLineageReceiptDigest: string;
  category: string;
  factKey: CandidateDurableRewriteFactKeyV1;
  role: "rewrite_representative" | "post_rewrite_dedupe_hold";
  proposedContentDigest: string;
  proposedNormalizedContentDigest: string;
  proposedAction:
    | "rewrite_candidate_under_separate_exact_apply"
    | "hold_candidate_until_post_rewrite_dedupe";
  mutationReady: false;
  proposedLifecycle: "candidate";
  proposedVerification: "unverified";
}

export interface CandidateDurableRewriteProposalV1 {
  summary: {
    targetGroups: number;
    targetRows: number;
    rewriteRepresentativeRows: number;
    postRewriteDedupeHoldRows: number;
    coveredByExistingTruthGroups: number;
    materiallyNewTruthGroups: number;
    captureSafeProposals: number;
    corpusCollisionRows: 0;
    mutationReadyRows: 0;
  };
  groups: CandidateDurableRewriteGroupV1[];
  rows: CandidateDurableRewriteRowV1[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validateSpecification(specification: CandidateDurableRewriteSpecificationV1): void {
  for (const digest of [
    specification.normalizedContentDigest,
    specification.representativeItemIdSha256,
    specification.knowledgeEvidenceDigest,
  ]) if (!isDigest(digest)) throw new Error("durable rewrite specification digest is invalid");
  if (!Number.isInteger(specification.expectedGroupSize) || specification.expectedGroupSize !== 2) {
    throw new Error("durable rewrite requires exact two-row duplicate groups");
  }
  if (![
    "local_collaboration_control_plane",
    "memory_capability_boundary",
    "episode_before_reviewer",
  ].includes(specification.factKey)) throw new Error("durable rewrite fact key is invalid");
  if (![
    "covered_by_existing_truth",
    "materially_new_bounded_truth",
  ].includes(specification.knowledgeCoverage)) throw new Error("durable rewrite knowledge coverage is invalid");
  if (
    specification.proposedContent !== specification.proposedContent.trim()
    || specification.proposedContent.length < 40
    || specification.proposedContent.length > 1_000
  ) throw new Error("durable rewrite content is outside the bounded prose contract");
}

export function planCandidateDurableRewriteProposalV1(
  rows: CandidateDuplicateTraceAdjudicationRowV1[],
  specifications: CandidateDurableRewriteSpecificationV1[],
  corpusContents: string[],
): CandidateDurableRewriteProposalV1 {
  const rewriteRows = rows.filter((row) => row.disposition === "hold_for_bounded_rewrite");
  if (rewriteRows.length === 0 || rewriteRows.length !== rows.length) {
    throw new Error("durable rewrite planning accepts the exact rewrite-hold lane only");
  }
  const groups = new Map<string, CandidateDuplicateTraceAdjudicationRowV1[]>();
  for (const row of rewriteRows) {
    if (
      row.basis !== "durable_fact_requires_rewrite"
      || row.proposedNextAction !== "bounded_rewrite_under_separate_review"
      || row.proposedLifecycle !== "candidate"
      || row.proposedVerification !== "unverified"
      || row.duplicateGroupSize !== 2
    ) throw new Error("durable rewrite row is outside the protected lane");
    for (const digest of [
      row.itemIdSha256,
      row.currentRevisionIdSha256,
      row.contentDigest,
      row.normalizedContentDigest,
      row.sourceLineageReceiptDigest,
      row.evidenceDigest,
    ]) if (!isDigest(digest)) throw new Error("durable rewrite row digest is invalid");
    const group = groups.get(row.normalizedContentDigest) ?? [];
    group.push(row);
    groups.set(row.normalizedContentDigest, group);
  }
  for (const group of groups.values()) {
    if (group.length !== 2 || new Set(group.map((row) => row.category)).size !== 1) {
      throw new Error("durable rewrite group is not an exact same-category pair");
    }
  }

  const specsByDigest = new Map<string, CandidateDurableRewriteSpecificationV1>();
  const factKeys = new Set<string>();
  for (const specification of specifications) {
    validateSpecification(specification);
    if (specsByDigest.has(specification.normalizedContentDigest)) {
      throw new Error("durable rewrite specifications must be unique");
    }
    if (factKeys.has(specification.factKey)) throw new Error("durable rewrite fact keys must be unique");
    specsByDigest.set(specification.normalizedContentDigest, specification);
    factKeys.add(specification.factKey);
  }
  if (specsByDigest.size !== groups.size) {
    throw new Error("durable rewrite specifications must cover every held group");
  }

  const corpusDigests = new Map<string, number>();
  for (const content of corpusContents) {
    const digest = hash(normalizeCandidateContentV1(content));
    corpusDigests.set(digest, (corpusDigests.get(digest) ?? 0) + 1);
  }
  const proposedDigests = new Set<string>();
  const plannedGroups: CandidateDurableRewriteGroupV1[] = [];
  for (const [normalizedContentDigest, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const specification = specsByDigest.get(normalizedContentDigest);
    if (!specification || specification.expectedGroupSize !== group.length) {
      throw new Error("durable rewrite specification no longer matches the exact group");
    }
    const orderedRows = [...group].sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
    if (specification.representativeItemIdSha256 !== orderedRows[0].itemIdSha256) {
      throw new Error("durable rewrite representative must be the deterministic first item hash");
    }
    const safety = evaluateCaptureSafety(specification.proposedContent);
    if (!safety.allowed) throw new Error("durable rewrite proposal still contains capture-unsafe trace material");
    const proposedNormalizedContentDigest = hash(normalizeCandidateContentV1(specification.proposedContent));
    if (proposedNormalizedContentDigest === normalizedContentDigest) {
      throw new Error("durable rewrite proposal did not change the unsafe normalized content");
    }
    if ((corpusDigests.get(proposedNormalizedContentDigest) ?? 0) !== 0) {
      throw new Error("durable rewrite proposal collides with current candidate content");
    }
    if (proposedDigests.has(proposedNormalizedContentDigest)) {
      throw new Error("durable rewrite proposals must be mutually distinct");
    }
    proposedDigests.add(proposedNormalizedContentDigest);
    plannedGroups.push({
      normalizedContentDigest,
      expectedGroupSize: group.length,
      representativeItemIdSha256: orderedRows[0].itemIdSha256,
      companionItemIdSha256: orderedRows[1].itemIdSha256,
      factKey: specification.factKey,
      category: orderedRows[0].category,
      knowledgeCoverage: specification.knowledgeCoverage,
      knowledgeEvidenceDigest: specification.knowledgeEvidenceDigest,
      proposedContentDigest: hash(specification.proposedContent),
      proposedNormalizedContentDigest,
      proposedContentLength: specification.proposedContent.length,
      captureSafetyAllowed: true,
      corpusCollisionRows: 0,
      proposedRepresentativeAction: "rewrite_candidate_under_separate_exact_apply",
      proposedCompanionAction: "hold_candidate_until_post_rewrite_dedupe",
    });
  }
  for (const digest of specsByDigest.keys()) {
    if (!groups.has(digest)) throw new Error("durable rewrite specification targets an unknown group");
  }

  const plannedByDigest = new Map(plannedGroups.map((group) => [group.normalizedContentDigest, group]));
  const plannedRows = rewriteRows.map((row): CandidateDurableRewriteRowV1 => {
    const group = plannedByDigest.get(row.normalizedContentDigest)!;
    const representative = row.itemIdSha256 === group.representativeItemIdSha256;
    return {
      itemIdSha256: row.itemIdSha256,
      currentRevisionIdSha256: row.currentRevisionIdSha256,
      contentDigest: row.contentDigest,
      normalizedContentDigest: row.normalizedContentDigest,
      sourceLineageReceiptDigest: row.sourceLineageReceiptDigest,
      category: row.category,
      factKey: group.factKey,
      role: representative ? "rewrite_representative" : "post_rewrite_dedupe_hold",
      proposedContentDigest: group.proposedContentDigest,
      proposedNormalizedContentDigest: group.proposedNormalizedContentDigest,
      proposedAction: representative
        ? "rewrite_candidate_under_separate_exact_apply"
        : "hold_candidate_until_post_rewrite_dedupe",
      mutationReady: false,
      proposedLifecycle: "candidate",
      proposedVerification: "unverified",
    };
  }).sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));

  return {
    summary: {
      targetGroups: plannedGroups.length,
      targetRows: plannedRows.length,
      rewriteRepresentativeRows: plannedRows.filter((row) => row.role === "rewrite_representative").length,
      postRewriteDedupeHoldRows: plannedRows.filter((row) => row.role === "post_rewrite_dedupe_hold").length,
      coveredByExistingTruthGroups: plannedGroups.filter((group) => group.knowledgeCoverage === "covered_by_existing_truth").length,
      materiallyNewTruthGroups: plannedGroups.filter((group) => group.knowledgeCoverage === "materially_new_bounded_truth").length,
      captureSafeProposals: plannedGroups.length,
      corpusCollisionRows: 0,
      mutationReadyRows: 0,
    },
    groups: plannedGroups,
    rows: plannedRows,
  };
}
