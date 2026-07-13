import { createHash } from "node:crypto";
import { evaluateCaptureSafety, sanitizeCaptureText, } from "../../capture-safety.js";
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function normalizedContent(value) {
    return sanitizeCaptureText(value).replace(/\s+/g, " ").trim().toLowerCase();
}
function lengthBand(length) {
    if (length < 4)
        return "lt4";
    if (length <= 200)
        return "le200";
    if (length <= 1_000)
        return "le1000";
    if (length <= 4_000)
        return "le4000";
    return "gt4000";
}
function increment(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}
function laneFor(input) {
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
export function validateSourceLineageReceiptV1(raw, expectedClassification) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return false;
    const receipt = raw;
    const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
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
export function assessCandidateContentQualityV1(targets, corpusContents) {
    const seen = new Set();
    const targetDigests = new Map();
    const corpusDigests = new Map();
    for (const content of corpusContents)
        increment(corpusDigests, hash(normalizedContent(content)));
    for (const target of targets) {
        if (!target.itemId.trim() || seen.has(target.itemId))
            throw new Error("content review item ids must be unique and non-empty");
        if (target.lifecycle !== "candidate" || target.verification !== "unverified") {
            throw new Error("content review accepts candidate/unverified rows only");
        }
        if (!/^[a-f0-9]{64}$/i.test(target.sourceLineageReceiptDigest)) {
            throw new Error("content review requires a source-lineage receipt digest");
        }
        seen.add(target.itemId);
        increment(targetDigests, hash(normalizedContent(target.content)));
    }
    const rows = targets.map((target) => {
        const normalized = normalizedContent(target.content);
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
    const lanes = [
        "capture_safety_reject_review",
        "oversized_content_review",
        "exact_duplicate_review",
        "manual_semantic_review",
    ];
    const counts = Object.fromEntries(lanes.map((lane) => [lane, rows.filter((row) => row.lane === lane).length]));
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
