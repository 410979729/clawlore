import type { ReflectionErrorSignal } from "./reflection-contracts.js";
import { BoundedTtlMap } from "./bounded-ttl-map.js";
import { parseReflectionMetadata } from "./reflection-metadata.js";
import {
  DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS,
  loadAgentReflectionSlicesFromEntries,
} from "./reflection-store.js";

type ReflectionEntry = Parameters<typeof loadAgentReflectionSlicesFromEntries>[0]["entries"][number];

type ReflectionStorePort = {
  list(
    scopeFilter?: string[],
    category?: string,
    limit?: number,
    offset?: number,
  ): Promise<ReflectionEntry[]>;
};

type ErrorState = {
  entries: ReflectionErrorSignal[];
  lastInjectedCount: number;
  signatureSet: Set<string>;
  updatedAt: number;
};

export class ReflectionRuntimeState {
  readonly #store: ReflectionStorePort;
  readonly #sessionTtlMs: number;
  readonly #maxTrackedSessions: number;
  readonly #now: () => number;
  readonly #errors = new Map<string, ErrorState>();
  readonly #derived = new Map<string, { updatedAt: number; derived: string[] }>();
  readonly #agentSlices: BoundedTtlMap<string, { invariants: string[]; derived: string[] }>;

  constructor(params: {
    store: ReflectionStorePort;
    sessionTtlMs: number;
    maxTrackedSessions: number;
    agentSliceTtlMs?: number;
    now?: () => number;
  }) {
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

  #pruneOldest<T extends { updatedAt: number }>(map: Map<string, T>): void {
    if (map.size <= this.#maxTrackedSessions) return;
    const sorted = [...map.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    for (let index = 0; index < map.size - this.#maxTrackedSessions; index += 1) {
      const key = sorted[index]?.[0];
      if (key) map.delete(key);
    }
  }

  prune(now = this.#now()): void {
    for (const [key, state] of this.#errors) {
      if (now - state.updatedAt > this.#sessionTtlMs) this.#errors.delete(key);
    }
    for (const [key, state] of this.#derived) {
      if (now - state.updatedAt > this.#sessionTtlMs) this.#derived.delete(key);
    }
    this.#agentSlices.prune(now);
    this.#pruneOldest(this.#errors);
    this.#pruneOldest(this.#derived);
  }

  #errorState(sessionKey: string): ErrorState {
    const key = sessionKey.trim();
    const current = this.#errors.get(key);
    if (current) {
      current.updatedAt = this.#now();
      return current;
    }
    const created: ErrorState = {
      entries: [],
      lastInjectedCount: 0,
      signatureSet: new Set<string>(),
      updatedAt: this.#now(),
    };
    this.#errors.set(key, created);
    return created;
  }

  addError(sessionKey: string, signal: ReflectionErrorSignal, dedupeEnabled: boolean): void {
    if (!sessionKey.trim()) return;
    this.prune();
    const state = this.#errorState(sessionKey);
    if (dedupeEnabled && state.signatureSet.has(signal.signatureHash)) return;
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

  pendingErrors(sessionKey: string, maxEntries: number): ReflectionErrorSignal[] {
    this.prune();
    const state = this.#errors.get(sessionKey.trim());
    if (!state) return [];
    state.updatedAt = this.#now();
    state.lastInjectedCount = Math.min(state.lastInjectedCount, state.entries.length);
    const pending = state.entries.slice(state.lastInjectedCount);
    if (pending.length === 0) return [];
    state.lastInjectedCount = state.entries.length;
    return pending.slice(-maxEntries);
  }

  errorEntries(sessionKey: string, maxEntries: number): ReflectionErrorSignal[] {
    return (this.#errors.get(sessionKey.trim())?.entries ?? []).slice(-maxEntries);
  }

  setDerived(sessionKey: string, derived: string[], updatedAt = this.#now()): void {
    this.prune(updatedAt);
    if (derived.length > 0) this.#derived.set(sessionKey.trim(), { updatedAt, derived });
    else this.#derived.delete(sessionKey.trim());
    this.#pruneOldest(this.#derived);
  }

  getDerived(sessionKey: string): string[] {
    this.prune();
    return this.#derived.get(sessionKey.trim())?.derived ?? [];
  }

  clearSession(sessionKey: string): void {
    const key = sessionKey.trim();
    this.#errors.delete(key);
    this.#derived.delete(key);
  }

  invalidateAgent(agentId: string): void {
    for (const key of this.#agentSlices.keys()) {
      if (key.startsWith(`${agentId}::`)) this.#agentSlices.delete(key);
    }
  }

  async loadAgentSlices(agentId: string, scopeFilter?: string[]) {
    this.prune();
    const scopeKey = Array.isArray(scopeFilter)
      ? `scopes:${[...scopeFilter].sort().join(",")}`
      : "<NO_SCOPE_FILTER>";
    const cacheKey = `${agentId}::${scopeKey}`;
    const cached = this.#agentSlices.get(cacheKey);
    if (cached) return cached;

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
        } catch {
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
