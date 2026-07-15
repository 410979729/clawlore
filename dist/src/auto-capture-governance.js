/**
 * Regex fallback after an extractor failure is evidence, not confirmed truth.
 * It remains queryable for operator review but cannot enter automatic prompt
 * injection until an explicit promotion changes its lifecycle state.
 */
export function regexFallbackGovernance(degradedReason) {
    const reason = degradedReason?.trim() || "";
    if (reason) {
        return {
            state: "pending",
            confidence: 0.35,
            trust: "degraded",
            extraction_degraded: true,
            degraded_reason: reason,
        };
    }
    return {
        state: "confirmed",
        confidence: 0.7,
        trust: "normal",
        extraction_degraded: false,
        degraded_reason: "",
    };
}
export function autoRecallGovernanceEligibility(meta) {
    if (meta.state !== "confirmed")
        return { eligible: false, reason: "state_not_confirmed" };
    if (meta.memory_layer === "archive" || meta.memory_layer === "reflection") {
        return { eligible: false, reason: `memory_layer_${String(meta.memory_layer)}` };
    }
    if (meta.trust === "degraded" || meta.extraction_degraded === true) {
        return { eligible: false, reason: "degraded_extraction" };
    }
    if (typeof meta.confidence === "number" && Number.isFinite(meta.confidence) && meta.confidence < 0.5) {
        return { eligible: false, reason: "low_confidence" };
    }
    return { eligible: true };
}
