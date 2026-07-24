import { CLAWLORE_LEGACY_RUNTIME_CONFIG_KEYS, CLAWLORE_RUNTIME_CONFIG_KEY, } from "./product-identity.js";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function intBetween(value, min, max, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return fallback;
    const integer = Math.floor(value);
    return integer >= min && integer <= max ? integer : fallback;
}
function normalizeRuntimeRequest(raw) {
    return {
        mode: ["shadow", "v2-write", "cutover"].includes(String(raw.mode))
            ? raw.mode
            : "disabled",
        contextEngine: raw.contextEngine === "native-opt-in" ? "native-opt-in" : "compatibility",
        tokenBudget: intBetween(raw.tokenBudget, 32, 32_768, 512),
        maxLatencyMs: intBetween(raw.maxLatencyMs, 25, 5_000, 750),
        traceFile: asNonEmptyString(raw.traceFile),
        maxTraceBytes: intBetween(raw.maxTraceBytes, 16_384, 100_000_000, 5_000_000),
        maxQueryChars: intBetween(raw.maxQueryChars, 256, 12_000, 4_000),
        candidateLimit: intBetween(raw.candidateLimit, 1, 20, 6),
        maxConcurrent: intBetween(raw.maxConcurrent, 1, 16, 2),
        readinessFile: asNonEmptyString(raw.readinessFile),
        approvalFile: asNonEmptyString(raw.approvalFile),
    };
}
function sameRuntimeRequest(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
/**
 * Resolves the canonical `runtime` object and the deprecated `clawloreV2`
 * alias into one internal contract. If both keys are present they must
 * normalize to the same value; ambiguity fails before hook registration.
 */
export function resolveClawLoreRuntimeRequestConfig(value) {
    if (!isRecord(value))
        return undefined;
    const canonicalPresent = Object.hasOwn(value, CLAWLORE_RUNTIME_CONFIG_KEY);
    const legacyKey = CLAWLORE_LEGACY_RUNTIME_CONFIG_KEYS[0];
    const legacyPresent = Object.hasOwn(value, legacyKey);
    const canonicalRaw = value[CLAWLORE_RUNTIME_CONFIG_KEY];
    const legacyRaw = value[legacyKey];
    if (canonicalPresent && !isRecord(canonicalRaw)) {
        throw new Error("ClawLore runtime configuration must be an object");
    }
    if (legacyPresent && !isRecord(legacyRaw)) {
        throw new Error("Deprecated ClawLore runtime configuration must be an object");
    }
    const canonical = isRecord(canonicalRaw) ? normalizeRuntimeRequest(canonicalRaw) : undefined;
    const legacy = isRecord(legacyRaw) ? normalizeRuntimeRequest(legacyRaw) : undefined;
    if (canonical && legacy && !sameRuntimeRequest(canonical, legacy)) {
        throw new Error("Conflicting ClawLore runtime and deprecated clawloreV2 configuration");
    }
    return canonical ?? legacy;
}
