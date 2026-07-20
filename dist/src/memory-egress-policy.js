import { containsSecret, redactKnownSecrets } from "./secret-redaction.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { isMemoryMetadataSafe } from "./memory-metadata-policy.js";
/**
 * Redact persisted memory text before it crosses a tool, prompt, diagnostic,
 * or support boundary. The second check is intentionally fail closed in case
 * overlapping secret shapes survive the targeted replacement pass.
 */
export function redactMemoryTextForOutput(text) {
    if (!text)
        return "";
    const sanitized = sanitizeCaptureText(text);
    const redacted = redactKnownSecrets(sanitized);
    if (containsSecret(redacted))
        return "[REDACTED_MEMORY_CONTENT]";
    return evaluateCaptureSafety(redacted).allowed ? redacted : "[REDACTED_MEMORY_CONTENT]";
}
/** Legacy rows predate the persistence gate, so every egress path must filter them. */
export function isMemoryEntrySafeForEgress(entry) {
    const normalizedText = entry.text.trim();
    const sanitizedText = sanitizeCaptureText(normalizedText);
    if (sanitizedText !== normalizedText || !evaluateCaptureSafety(sanitizedText).allowed)
        return false;
    if (entry.metadata == null)
        return true;
    return isMemoryMetadataSafe(entry.metadata);
}
export function redactMemoryEntryForOutput(entry) {
    return {
        ...entry,
        text: redactMemoryTextForOutput(entry.text),
        ...(typeof entry.metadata === "string"
            ? { metadata: redactMemoryTextForOutput(entry.metadata) }
            : entry.metadata == null ? {} : { metadata: "[REDACTED_UNSUPPORTED_METADATA]" }),
        ...(entry.scope ? { scope: redactMemoryTextForOutput(entry.scope) } : {}),
    };
}
export function filterUnsafeMemoryResults(results) {
    return results.filter((result) => isMemoryEntrySafeForEgress(result.entry));
}
export function memoryTextRequiresLocalProcessing(text) {
    const normalized = text.trim();
    const sanitized = sanitizeCaptureText(normalized);
    return sanitized !== normalized || !evaluateCaptureSafety(sanitized).allowed;
}
