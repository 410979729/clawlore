export type BoundedTtlEvictionReason = "ttl" | "capacity";

export interface BoundedTtlMapStats {
  size: number;
  ttlEvictions: number;
  capacityEvictions: number;
}

type Entry<V> = {
  value: V;
  touchedAt: number;
};

export class BoundedTtlMap<K, V> {
  readonly #entries = new Map<K, Entry<V>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #onEvict?: (key: K, reason: BoundedTtlEvictionReason) => void;
  #ttlEvictions = 0;
  #capacityEvictions = 0;

  constructor(options: {
    ttlMs: number;
    maxEntries: number;
    now?: () => number;
    onEvict?: (key: K, reason: BoundedTtlEvictionReason) => void;
  }) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("BoundedTtlMap ttlMs must be positive");
    }
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error("BoundedTtlMap maxEntries must be a positive integer");
    }
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
    this.#onEvict = options.onEvict;
  }

  #evict(key: K, reason: BoundedTtlEvictionReason): void {
    if (!this.#entries.delete(key)) return;
    if (reason === "ttl") this.#ttlEvictions += 1;
    else this.#capacityEvictions += 1;
    this.#onEvict?.(key, reason);
  }

  prune(now = this.#now()): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.touchedAt >= this.#ttlMs) this.#evict(key, "ttl");
    }
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.#evict(oldest, "capacity");
    }
  }

  get(key: K): V | undefined {
    const now = this.#now();
    this.prune(now);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, { value: entry.value, touchedAt: now });
    return entry.value;
  }

  set(key: K, value: V): this {
    const now = this.#now();
    this.prune(now);
    this.#entries.delete(key);
    this.#entries.set(key, { value, touchedAt: now });
    this.prune(now);
    return this;
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  keys(): K[] {
    this.prune();
    return [...this.#entries.keys()];
  }

  stats(): BoundedTtlMapStats {
    this.prune();
    return {
      size: this.#entries.size,
      ttlEvictions: this.#ttlEvictions,
      capacityEvictions: this.#capacityEvictions,
    };
  }
}
