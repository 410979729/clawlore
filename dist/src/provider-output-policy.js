import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
/**
 * Provider explanations and labels are untrusted output. Keep only bounded,
 * single-line, capture-safe text before logging or persisting them.
 */
export function normalizeProviderAnnotation(value, maxChars = 240) {
    if (typeof value !== "string" || !Number.isFinite(maxChars) || maxChars < 1) {
        return undefined;
    }
    const safety = evaluateCaptureSafety(value);
    if (!safety.allowed)
        return undefined;
    const normalized = sanitizeCaptureText(value).replace(/\s+/g, " ").trim();
    return normalized ? normalized.slice(0, Math.trunc(maxChars)) : undefined;
}
