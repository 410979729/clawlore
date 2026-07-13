import { createHash } from "node:crypto";
import {
  evaluateCaptureSafety,
  sanitizeCaptureText,
  type CaptureSafetyReason,
} from "../../capture-safety.js";

export type CandidateContentQualityReviewLaneV1 =
  | "capture_safety_reject_review"
  | "oversized_content_review"
  | "exact_duplicate_review"
  | "manual_semantic_review";

export interface CandidateContentQualityInputV1 {
  itemId: string;
  currentRevisionId: string;
  content: string;
  category: string;
  lifecycle: "candidate";
  verification: "unverified";
  sourceLineageReceiptDigest: string;
}

export interface CandidateContentQualityReviewRowV1 {
  itemIdSha256: string;
  currentRevisionIdSha256: string;
  contentDigest: string;
  normalizedContentDigest: string;
  sourceLineageReceiptDigest: string;
  category: string;
  contentLengthBand: "lt4" | "le200" | "le1000" | "le4000" | "gt4000";
  captureSafety: {
    allowed: boolean;
    reason?: CaptureSafetyReason;
    pattern?: string;
  };
  targetDuplicateGroupSize: number;
  corpusDuplicateGroupSize: number;
  signals: string[];
  lane: CandidateContentQualityReviewLaneV1;
  requiredActions: string[];
  postLifecycle: "candidate";
  postVerification: "unverified";
}

export interface CandidateContentQualityAssessmentV1 {
  counts: Record<CandidateContentQualityReviewLaneV1, number>;
  summary: {
    targetRows: number;
    structurallyReviewableRows: number;
    captureSafetyRejectedRows: number;
    exactDuplicateRows: number;
    exactDuplicateGroups: number;
    oversizedRows: number;
    manualSemanticReviewRows: number;
    mutationReadyRows: 0;
  };
  rows: CandidateContentQualityReviewRowV1[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeCandidateContentV1(value: string): string {
  return sanitizeCaptureText(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function lengthBand(length: number): CandidateContentQualityReviewRowV1["contentLengthBand"] {
  if (length < 4) return "lt4";
  if (length <= 200) return "le200";
  if (length <= 1_000) return "le1000";
  if (length <= 4_000) return "le4000";
  return "gt4000";
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function laneFor(input: {
  captureAllowed: boolean;
  oversized: boolean;
  duplicate: boolean;
}): { lane: CandidateContentQualityReviewLaneV1; requiredActions: string[] } {
  if (!input.captureAllowed) {
    return {
      lane: "capture_safety_reject_review",
      requiredActions: ["review_capture_safety_rejection", "keep_candidate", "do_not_promote"],
    };
  }
  if (input.oversized) {
    return {
      lane: "oversized_content_review",
      requiredActions: ["segment_or_rewrite_content", "operator_review", "keep_candidate_until_verified"],
    };
  }
  if (input.duplicate) {
    return {
      lane: "exact_duplicate_review",
      requiredActions: ["compare_exact_duplicate_group", "select_canonical_or_keep_candidate", "operator_review"],
    };
  }
  return {
    lane: "manual_semantic_review",
    requiredActions: ["review_factual_accuracy", "review_durability", "review_scope", "keep_candidate_until_operator_decision"],
  };
}

export function validateSourceLineageReceiptV1(raw: unknown, expectedClassification: string): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const receipt = raw as Record<string, unknown>;
  const digest = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
  const recordedAt = typeof receipt.recordedAt === "string" ? Date.parse(receipt.recordedAt) : Number.NaN;
  return receipt.schemaVersion === 1
    && receipt.evidenceKind === "source-lineage-receipt"
    && receipt.supportsSourceLineageOnly === true
    && receipt.authorizesLifecycleChange === false
    && receipt.authorizesVerificationChange === false
    && receipt.preservesLifecycle === true
    && receipt.preservesVerification === true
    && receipt.classification === expectedClassification
    && typeof receipt.rolloutId === "string"
    && Boolean(receipt.rolloutId.trim())
    && digest(receipt.planDigest)
    && digest(receipt.proposedReceiptPayloadDigest)
    && digest(receipt.sourceEvidenceDigest)
    && digest(receipt.eventEvidenceDigest)
    && Number.isFinite(recordedAt);
}

export function assessCandidateContentQualityV1(
  targets: CandidateContentQualityInputV1[],
  corpusContents: string[],
): CandidateContentQualityAssessmentV1 {
  const seen = new Set<string>();
  const targetDigests = new Map<string, number>();
  const corpusDigests = new Map<string, number>();
  for (const content of corpusContents) increment(corpusDigests, hash(normalizeCandidateContentV1(content)));
  for (const target of targets) {
    if (!target.itemId.trim() || seen.has(target.itemId)) throw new Error("content review item ids must be unique and non-empty");
    if (target.lifecycle !== "candidate" || target.verification !== "unverified") {
      throw new Error("content review accepts candidate/unverified rows only");
    }
    if (!/^[a-f0-9]{64}$/i.test(target.sourceLineageReceiptDigest)) {
      throw new Error("content review requires a source-lineage receipt digest");
    }
    seen.add(target.itemId);
    increment(targetDigests, hash(normalizeCandidateContentV1(target.content)));
  }

  const rows = targets.map((target): CandidateContentQualityReviewRowV1 => {
    const normalized = normalizeCandidateContentV1(target.content);
    const normalizedDigest = hash(normalized);
    const safety = evaluateCaptureSafety(target.content);
    const targetDuplicateGroupSize = targetDigests.get(normalizedDigest) ?? 0;
    const corpusDuplicateGroupSize = corpusDigests.get(normalizedDigest) ?? 0;
    const duplicate = targetDuplicateGroupSize > 1 || corpusDuplicateGroupSize > 1;
    const oversized = normalized.length > 4_000;
    const signals = [
      ...(!safety.allowed ? [`capture_safety:${safety.reason ?? "unknown"}`] : []),
      ...(duplicate ? ["exact_normalized_duplicate"] : []),
      ...(oversized ? ["content_over_4000_chars"] : []),
    ].sort();
    return {
      itemIdSha256: hash(target.itemId),
      currentRevisionIdSha256: hash(target.currentRevisionId),
      contentDigest: hash(target.content),
      normalizedContentDigest: normalizedDigest,
      sourceLineageReceiptDigest: target.sourceLineageReceiptDigest,
      category: target.category,
      contentLengthBand: lengthBand(normalized.length),
      captureSafety: {
        allowed: safety.allowed,
        ...(safety.reason ? { reason: safety.reason } : {}),
        ...(safety.pattern ? { pattern: safety.pattern } : {}),
      },
      targetDuplicateGroupSize,
      corpusDuplicateGroupSize,
      signals,
      ...laneFor({ captureAllowed: safety.allowed, oversized, duplicate }),
      postLifecycle: "candidate",
      postVerification: "unverified",
    };
  });

  const lanes: CandidateContentQualityReviewLaneV1[] = [
    "capture_safety_reject_review",
    "oversized_content_review",
    "exact_duplicate_review",
    "manual_semantic_review",
  ];
  const counts = Object.fromEntries(
    lanes.map((lane) => [lane, rows.filter((row) => row.lane === lane).length]),
  ) as Record<CandidateContentQualityReviewLaneV1, number>;
  const duplicateRows = rows.filter((row) => row.targetDuplicateGroupSize > 1 || row.corpusDuplicateGroupSize > 1);
  const duplicateGroups = new Set(duplicateRows.map((row) => row.normalizedContentDigest));
  return {
    counts,
    summary: {
      targetRows: rows.length,
      structurallyReviewableRows: rows.filter((row) => row.captureSafety.allowed).length,
      captureSafetyRejectedRows: rows.filter((row) => !row.captureSafety.allowed).length,
      exactDuplicateRows: duplicateRows.length,
      exactDuplicateGroups: duplicateGroups.size,
      oversizedRows: rows.filter((row) => row.contentLengthBand === "gt4000").length,
      manualSemanticReviewRows: counts.manual_semantic_review,
      mutationReadyRows: 0,
    },
    rows,
  };
}
