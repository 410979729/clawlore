export function parseMetadataObject(rawMetadata) {
    if (!rawMetadata)
        return {};
    try {
        const parsed = JSON.parse(rawMetadata);
        return parsed && typeof parsed === "object"
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
export function normalizeState(value) {
    switch (value) {
        case "pending":
        case "confirmed":
        case "archived":
        case "rejected":
            return value;
        default:
            return "confirmed";
    }
}
export function normalizeSource(value) {
    switch (value) {
        case "manual":
        case "auto-capture":
        case "task-experience":
        case "reflection":
        case "session-summary":
        case "legacy":
            return value;
        default:
            return "legacy";
    }
}
export function normalizeLayer(value) {
    switch (value) {
        case "durable":
        case "working":
        case "reflection":
        case "archive":
            return value;
        default:
            return "working";
    }
}
export function normalizeTimestamp(value, fallback) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.floor(parsed);
}
export function normalizeOptionalTimestamp(value) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return undefined;
    return Math.floor(parsed);
}
function deriveDefaultLayer(source, memoryCategory, state) {
    if (source === "reflection" || source === "session-summary")
        return "reflection";
    if (state === "archived" || state === "rejected")
        return "archive";
    if (memoryCategory === "profile"
        || memoryCategory === "preferences"
        || memoryCategory === "events") {
        return "durable";
    }
    return "working";
}
export function normalizeLifecycleFieldsFromParsed(parsed, input) {
    const timestamp = typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
        ? input.timestamp
        : Date.now();
    const fallbackSource = parsed.type === "session-summary"
        ? "session-summary"
        : parsed.type === "memory-reflection" || parsed.type === "memory-reflection-item"
            ? "reflection"
            : "legacy";
    const source = normalizeSource(parsed.source ?? fallbackSource);
    const state = normalizeState(parsed.state ?? (source === "session-summary" ? "archived" : "confirmed"));
    const memoryLayer = normalizeLayer(parsed.memory_layer ?? deriveDefaultLayer(source, input.memoryCategory, state));
    const validFrom = normalizeTimestamp(parsed.valid_from, timestamp);
    const invalidatedAt = normalizeOptionalTimestamp(parsed.invalidated_at);
    return {
        state,
        source,
        memory_layer: memoryLayer,
        lifecycle: parsed.lifecycle,
        valid_from: validFrom,
        invalidated_at: invalidatedAt && invalidatedAt >= validFrom ? invalidatedAt : undefined,
    };
}
export function staticLifecycleForMetadata(metadata) {
    const state = String(metadata.state ?? "").trim().toLowerCase();
    const layer = String(metadata.memory_layer ?? "").trim().toLowerCase();
    const lifecycle = String(metadata.lifecycle ?? "").trim().toLowerCase();
    if (state === "rejected" || ["obsolete", "rejected", "superseded"].includes(lifecycle)) {
        return "inactive";
    }
    if (state === "archived" || layer === "archive" || lifecycle === "archived") {
        return "archived";
    }
    return "dynamic";
}
