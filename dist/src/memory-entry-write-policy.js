import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { assertMemoryMetadataSafe } from "./memory-metadata-policy.js";
import { containsSecret } from "./secret-redaction.js";
const MEMORY_CATEGORIES = new Set([
    "preference",
    "fact",
    "decision",
    "entity",
    "other",
    "reflection",
]);
function requireBoundedText(value, label, maxLength) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${label} is required`);
    if (value.length > maxLength)
        throw new Error(`${label} exceeds the size limit`);
    if (value !== value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        throw new Error(`${label} contains invalid boundary characters`);
    }
    return value;
}
/**
 * Final fail-closed policy before a runtime entry reaches SQL truth. Upstream
 * capture and review gates remain useful, but no caller may bypass credential,
 * shape, or size validation by invoking MemoryStore directly.
 */
export function assertMemoryEntrySafeForPersistence(entry) {
    if (!entry || typeof entry !== "object")
        throw new Error("memory entry is required");
    if (entry.id != null)
        requireBoundedText(entry.id, "memory id", 512);
    const text = requireBoundedText(entry.text, "memory text", 64_000);
    const sanitizedText = sanitizeCaptureText(text);
    if (sanitizedText !== text || !evaluateCaptureSafety(sanitizedText).allowed) {
        throw new Error("memory text rejected by safety policy");
    }
    if (typeof entry.category !== "string" || !MEMORY_CATEGORIES.has(entry.category)) {
        throw new Error("memory category is unsupported");
    }
    const scope = requireBoundedText(entry.scope, "memory scope", 512);
    if (!/^[\p{L}\p{N}._:-]+$/u.test(scope) || containsSecret(scope)) {
        throw new Error("memory scope rejected by safety policy");
    }
    if (typeof entry.importance !== "number" || !Number.isFinite(entry.importance)
        || entry.importance < 0 || entry.importance > 1) {
        throw new Error("memory importance must be between 0 and 1");
    }
    if (entry.timestamp != null && (typeof entry.timestamp !== "number"
        || !Number.isFinite(entry.timestamp) || entry.timestamp < 0)) {
        throw new Error("memory timestamp must be a non-negative finite number");
    }
    if (!Array.isArray(entry.vector) || entry.vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error("memory vector must contain only finite numbers");
    }
    if (entry.metadata == null)
        return;
    if (typeof entry.metadata !== "string" || entry.metadata.length > 262_144) {
        throw new Error("memory metadata exceeds the size limit");
    }
    let parsed;
    try {
        parsed = JSON.parse(entry.metadata);
    }
    catch {
        throw new Error("memory metadata must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("memory metadata must be a JSON object");
    }
    assertMemoryMetadataSafe(parsed);
}
