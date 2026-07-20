import { BoundedTtlMap } from "./bounded-ttl-map.js";
import { parseReflectionMetadata } from "./reflection-metadata.js";
import { DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS, loadAgentReflectionSlicesFromEntries, } from "./reflection-store.js";
export class ReflectionRuntimeState {
    #store;
    #sessionTtlMs;
    #maxTrackedSessions;
    #now;
    #errors = new Map();
    #derived = new Map();
    #agentSlices;
    constructor(params) {
        this.#store = params.store;
        this.#sessionTtlMs = params.sessionTtlMs;
        this.#maxTrackedSessions = params.maxTrackedSessions;
        this.#now = params.now ?? Date.now;
        this.#agentSlices = new BoundedTtlMap({
            ttlMs: params.agentSliceTtlMs ?? 15_000,
            maxEntries: params.maxTrackedSessions,
            now: this.#now,
        });
    }
    #pruneOldest(map) {
        if (map.size <= this.#maxTrackedSessions)
            return;
        const sorted = [...map.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
        for (let index = 0; index < map.size - this.#maxTrackedSessions; index += 1) {
            const key = sorted[index]?.[0];
            if (key)
                map.delete(key);
        }
    }
    prune(now = this.#now()) {
        for (const [key, state] of this.#errors) {
            if (now - state.updatedAt > this.#sessionTtlMs)
                this.#errors.delete(key);
        }
        for (const [key, state] of this.#derived) {
            if (now - state.updatedAt > this.#sessionTtlMs)
                this.#derived.delete(key);
        }
        this.#agentSlices.prune(now);
        this.#pruneOldest(this.#errors);
        this.#pruneOldest(this.#derived);
    }
    #errorState(sessionKey) {
        const key = sessionKey.trim();
        const current = this.#errors.get(key);
        if (current) {
            current.updatedAt = this.#now();
            return current;
        }
        const created = {
            entries: [],
            lastInjectedCount: 0,
            signatureSet: new Set(),
            updatedAt: this.#now(),
        };
        this.#errors.set(key, created);
        return created;
    }
    addError(sessionKey, signal, dedupeEnabled) {
        if (!sessionKey.trim())
            return;
        this.prune();
        const state = this.#errorState(sessionKey);
        if (dedupeEnabled && state.signatureSet.has(signal.signatureHash))
            return;
        state.entries.push(signal);
        state.signatureSet.add(signal.signatureHash);
        state.updatedAt = this.#now();
        if (state.entries.length > 30) {
            const removed = state.entries.length - 30;
            state.entries.splice(0, removed);
            state.lastInjectedCount = Math.max(0, state.lastInjectedCount - removed);
            state.signatureSet = new Set(state.entries.map((entry) => entry.signatureHash));
        }
    }
    pendingErrors(sessionKey, maxEntries) {
        this.prune();
        const state = this.#errors.get(sessionKey.trim());
        if (!state)
            return [];
        state.updatedAt = this.#now();
        state.lastInjectedCount = Math.min(state.lastInjectedCount, state.entries.length);
        const pending = state.entries.slice(state.lastInjectedCount);
        if (pending.length === 0)
            return [];
        state.lastInjectedCount = state.entries.length;
        return pending.slice(-maxEntries);
    }
    errorEntries(sessionKey, maxEntries) {
        return (this.#errors.get(sessionKey.trim())?.entries ?? []).slice(-maxEntries);
    }
    setDerived(sessionKey, derived, updatedAt = this.#now()) {
        this.prune(updatedAt);
        if (derived.length > 0)
            this.#derived.set(sessionKey.trim(), { updatedAt, derived });
        else
            this.#derived.delete(sessionKey.trim());
        this.#pruneOldest(this.#derived);
    }
    getDerived(sessionKey) {
        this.prune();
        return this.#derived.get(sessionKey.trim())?.derived ?? [];
    }
    clearSession(sessionKey) {
        const key = sessionKey.trim();
        this.#errors.delete(key);
        this.#derived.delete(key);
    }
    invalidateAgent(agentId) {
        for (const key of this.#agentSlices.keys()) {
            if (key.startsWith(`${agentId}::`))
                this.#agentSlices.delete(key);
        }
    }
    async loadAgentSlices(agentId, scopeFilter) {
        this.prune();
        const scopeKey = Array.isArray(scopeFilter)
            ? `scopes:${[...scopeFilter].sort().join(",")}`
            : "<NO_SCOPE_FILTER>";
        const cacheKey = `${agentId}::${scopeKey}`;
        const cached = this.#agentSlices.get(cacheKey);
        if (cached)
            return cached;
        let entries = await this.#store.list(scopeFilter, "reflection", 240, 0);
        let slices = loadAgentReflectionSlicesFromEntries({
            entries,
            agentId,
            deriveMaxAgeMs: DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
        });
        if (slices.invariants.length === 0 && slices.derived.length === 0) {
            entries = (await this.#store.list(scopeFilter, undefined, 240, 0)).filter((entry) => {
                try {
                    const metadata = parseReflectionMetadata(entry.metadata);
                    const owner = typeof metadata.agentId === "string" ? metadata.agentId.trim() : "";
                    const reflectionType = metadata.type === "memory-reflection-item" || metadata.type === "memory-reflection";
                    return reflectionType && (!owner || owner === agentId || owner === "main");
                }
                catch {
                    return false;
                }
            });
            slices = loadAgentReflectionSlicesFromEntries({
                entries,
                agentId,
                deriveMaxAgeMs: DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
            });
        }
        const next = { invariants: slices.invariants, derived: slices.derived };
        this.#agentSlices.set(cacheKey, next);
        return next;
    }
}
