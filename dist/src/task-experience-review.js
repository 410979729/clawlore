const MAX_LIST_ITEMS = 8;
const MAX_ITEM_CHARS = 260;
function compactWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function truncate(value, maxChars) {
    const trimmed = value.trim();
    if (trimmed.length <= maxChars)
        return trimmed;
    return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
function clampNumber(value, fallback, min, max) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
function asStringList(value) {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (typeof item !== "string")
            continue;
        const text = truncate(compactWhitespace(item), MAX_ITEM_CHARS);
        if (!text || seen.has(text.toLowerCase()))
            continue;
        seen.add(text.toLowerCase());
        out.push(text);
        if (out.length >= MAX_LIST_ITEMS)
            break;
    }
    return out;
}
/**
 * Validate an untrusted reviewer response and return a stable, content-free
 * rejection code. The diagnostic code is safe to persist in governance
 * ledgers; model prose and transcript fragments are deliberately excluded.
 */
export function diagnoseTaskExperienceReview(raw, minConfidence) {
    if (raw == null)
        return { ok: false, reason: "review_response_unavailable" };
    if (typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, reason: "review_invalid_shape" };
    }
    const obj = raw;
    if (typeof obj.should_store !== "boolean") {
        return { ok: false, reason: "review_invalid_shape" };
    }
    const review = {
        should_store: obj.should_store,
        confidence: clampNumber(obj.confidence, 0, 0, 1),
        task_type: truncate(compactWhitespace(typeof obj.task_type === "string" ? obj.task_type : ""), 140),
        trigger_phrases: asStringList(obj.trigger_phrases),
        applicability: asStringList(obj.applicability),
        preconditions: asStringList(obj.preconditions),
        steps: asStringList(obj.steps),
        verification: asStringList(obj.verification),
        failure_signals: asStringList(obj.failure_signals),
        safety_boundaries: asStringList(obj.safety_boundaries),
        cleanup: asStringList(obj.cleanup),
        evidence_required: asStringList(obj.evidence_required),
        do_not_store_reason: typeof obj.do_not_store_reason === "string"
            ? truncate(compactWhitespace(obj.do_not_store_reason), 300)
            : undefined,
    };
    // A reviewer may decline without filling the reusable-capsule fields.
    if (!review.should_store)
        return { ok: true, review };
    if (review.confidence < minConfidence) {
        return { ok: false, reason: "review_confidence_below_threshold" };
    }
    if (!review.task_type)
        return { ok: false, reason: "review_task_type_missing" };
    if (review.steps.length < 2)
        return { ok: false, reason: "review_steps_insufficient" };
    if (review.verification.length < 1) {
        return { ok: false, reason: "review_verification_missing" };
    }
    return { ok: true, review };
}
/** Compatibility wrapper for callers that only need the accepted review. */
export function normalizeTaskExperienceReview(raw, minConfidence) {
    const diagnostic = diagnoseTaskExperienceReview(raw, minConfidence);
    return diagnostic.ok ? diagnostic.review : null;
}
