import { createHash } from "node:crypto";
import type {
  CandidateDurableRewriteFactKeyV1,
  CandidateDurableRewriteKnowledgeCoverageV1,
} from "./candidate-durable-rewrite-proposal.js";

export type CandidateCompanionDispositionLaneV1 =
  | "command_trace_rejection_review"
  | "tool_payload_rejection_review";

export interface CandidateCompanionDispositionInputV1 {
  factKey: CandidateDurableRewriteFactKeyV1;
  knowledgeCoverage: CandidateDurableRewriteKnowledgeCoverageV1;
  knowledgeEvidenceDigest: string;
  representativeItemIdSha256: string;
  representativeCurrentRevisionIdSha256: string;
  representativeContentDigest: string;
  representativeNormalizedContentDigest: string;
  representativeSourceLineageReceiptDigest: string;
  representativeRewriteReceiptDigest: string;
  companionItemIdSha256: string;
  companionCurrentRevisionIdSha256: string;
  companionContentDigest: string;
  companionNormalizedContentDigest: string;
  companionSourceLineageReceiptDigest: string;
  category: string;
  captureSafetyReason: "operational-trace";
  captureSafetyPattern: string;
  captureSafetyLane: CandidateCompanionDispositionLaneV1;
}

export interface CandidateCompanionDispositionRowV1 extends CandidateCompanionDispositionInputV1 {
  disposition: "propose_soft_archive";
  basis: "bounded_fact_preserved_and_original_trace_is_unsafe";
  proposedAction: "soft_archive_under_separate_exact_apply";
  mutationReady: false;
  currentLifecycle: "candidate";
  proposedLifecycle: "archived";
  proposedVerification: "unverified";
}

export interface CandidateCompanionDispositionPlanV1 {
  summary: {
    targetGroups: 3;
    targetRows: 3;
    softArchiveProposalRows: 3;
    commandTraceRows: number;
    toolPayloadRows: number;
    coveredByExistingTruthRows: number;
    materiallyNewBoundedTruthRows: number;
    mutationReadyRows: 0;
  };
  rows: CandidateCompanionDispositionRowV1[];
}

const FACT_KEYS = new Set<CandidateDurableRewriteFactKeyV1>([
  "local_collaboration_control_plane",
  "memory_capability_boundary",
  "episode_before_reviewer",
]);

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function digestCandidateCompanionDispositionV1(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function planCandidateCompanionDispositionV1(
  inputs: CandidateCompanionDispositionInputV1[],
): CandidateCompanionDispositionPlanV1 {
  if (inputs.length !== 3) throw new Error("companion disposition requires exactly three rewrite groups");
  const factKeys = new Set(inputs.map((row) => row.factKey));
  const representatives = new Set(inputs.map((row) => row.representativeItemIdSha256));
  const companions = new Set(inputs.map((row) => row.companionItemIdSha256));
  if (factKeys.size !== 3 || [...factKeys].some((key) => !FACT_KEYS.has(key))) {
    throw new Error("companion disposition must cover the exact three durable rewrite facts");
  }
  if (representatives.size !== 3 || companions.size !== 3) {
    throw new Error("companion disposition item bindings must be unique");
  }
  if ([...representatives].some((digest) => companions.has(digest))) {
    throw new Error("companion disposition representative and companion sets must not overlap");
  }
  for (const input of inputs) {
    const digests = [
      input.knowledgeEvidenceDigest,
      input.representativeItemIdSha256,
      input.representativeCurrentRevisionIdSha256,
      input.representativeContentDigest,
      input.representativeNormalizedContentDigest,
      input.representativeSourceLineageReceiptDigest,
      input.representativeRewriteReceiptDigest,
      input.companionItemIdSha256,
      input.companionCurrentRevisionIdSha256,
      input.companionContentDigest,
      input.companionNormalizedContentDigest,
      input.companionSourceLineageReceiptDigest,
    ];
    if (digests.some((digest) => !isDigest(digest))) {
      throw new Error("companion disposition contains an invalid evidence digest");
    }
    if (!input.category.trim() || input.captureSafetyReason !== "operational-trace") {
      throw new Error("companion disposition requires an unsafe operational trace");
    }
    if (
      input.captureSafetyLane === "command_trace_rejection_review"
        ? input.captureSafetyPattern !== "command-hints-block"
        : input.captureSafetyLane === "tool_payload_rejection_review"
          ? input.captureSafetyPattern !== "tool-fields-block"
          : true
    ) throw new Error("companion disposition safety lane and pattern do not agree");
    if (
      input.knowledgeCoverage !== "covered_by_existing_truth"
      && input.knowledgeCoverage !== "materially_new_bounded_truth"
    ) throw new Error("companion disposition knowledge coverage is invalid");
  }
  const rows = inputs.map<CandidateCompanionDispositionRowV1>((input) => ({
    ...input,
    disposition: "propose_soft_archive",
    basis: "bounded_fact_preserved_and_original_trace_is_unsafe",
    proposedAction: "soft_archive_under_separate_exact_apply",
    mutationReady: false,
    currentLifecycle: "candidate",
    proposedLifecycle: "archived",
    proposedVerification: "unverified",
  })).sort((left, right) => left.companionItemIdSha256.localeCompare(right.companionItemIdSha256));
  return {
    summary: {
      targetGroups: 3,
      targetRows: 3,
      softArchiveProposalRows: 3,
      commandTraceRows: rows.filter((row) => row.captureSafetyLane === "command_trace_rejection_review").length,
      toolPayloadRows: rows.filter((row) => row.captureSafetyLane === "tool_payload_rejection_review").length,
      coveredByExistingTruthRows: rows.filter((row) => row.knowledgeCoverage === "covered_by_existing_truth").length,
      materiallyNewBoundedTruthRows: rows.filter((row) => row.knowledgeCoverage === "materially_new_bounded_truth").length,
      mutationReadyRows: 0,
    },
    rows,
  };
}
