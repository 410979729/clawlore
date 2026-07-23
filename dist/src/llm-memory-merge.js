import { isMemoryEntrySafeForEgress } from "./memory-egress-policy.js";
import { evaluateMemoryMergePayload, } from "./memory-merge-policy.js";
import { isMemoryUpdateConflict, snapshotMemoryEntry, } from "./memory-store-ports.js";
/**
 * Re-read and retry once when another writer changes the source while the LLM
 * or embedding request is in flight. A stale provider result is never allowed
 * to overwrite a newer durable revision.
 */
export async function applyLlmMemoryMergeWithCas(input) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let existing;
        try {
            existing = await input.store.getById(input.memoryId, input.scopeFilter);
        }
        catch {
            return { status: "fallback", reason: "source read failed" };
        }
        if (!existing || !isMemoryEntrySafeForEgress(existing)) {
            return { status: "fallback", reason: "source missing or unsafe" };
        }
        let providerOutput;
        try {
            providerOutput = await input.completeJson(input.buildPrompt(existing));
        }
        catch {
            return { status: "fallback", reason: "provider failed" };
        }
        const decision = evaluateMemoryMergePayload(providerOutput);
        if (!decision.allowed) {
            return { status: "fallback", reason: `output rejected (${decision.reason})` };
        }
        const payload = decision.value;
        const vector = await input.embed(`${payload.abstract} ${payload.content}`);
        try {
            const updated = await input.store.update(input.memoryId, input.buildUpdates(existing, payload, vector), input.scopeFilter, { expected: snapshotMemoryEntry(existing) });
            if (!updated)
                return { status: "fallback", reason: "source disappeared" };
            return { status: "merged", entry: updated, payload };
        }
        catch (error) {
            if (!isMemoryUpdateConflict(error))
                throw error;
        }
    }
    return { status: "fallback", reason: "source changed concurrently" };
}
