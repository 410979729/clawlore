export class MemoryUpdateConflictError extends Error {
    code = "CLAWLORE_MEMORY_UPDATE_CONFLICT";
    constructor() {
        super("memory changed after it was read");
        this.name = "MemoryUpdateConflictError";
    }
}
export function snapshotMemoryEntry(entry) {
    return {
        id: entry.id,
        text: entry.text,
        category: entry.category,
        scope: entry.scope,
        importance: entry.importance,
        timestamp: entry.timestamp,
        metadata: entry.metadata ?? "{}",
    };
}
export function memoryEntryMatchesSnapshot(entry, snapshot) {
    const current = snapshotMemoryEntry(entry);
    return Object.keys(current).every((key) => current[key] === snapshot[key]);
}
export function isMemoryUpdateConflict(error) {
    return Boolean(error
        && typeof error === "object"
        && error.code === "CLAWLORE_MEMORY_UPDATE_CONFLICT");
}
