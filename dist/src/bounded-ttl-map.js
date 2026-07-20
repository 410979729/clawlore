export class BoundedTtlMap {
    #entries = new Map();
    #ttlMs;
    #maxEntries;
    #now;
    #onEvict;
    #ttlEvictions = 0;
    #capacityEvictions = 0;
    constructor(options) {
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
    #evict(key, reason) {
        if (!this.#entries.delete(key))
            return;
        if (reason === "ttl")
            this.#ttlEvictions += 1;
        else
            this.#capacityEvictions += 1;
        this.#onEvict?.(key, reason);
    }
    prune(now = this.#now()) {
        for (const [key, entry] of this.#entries) {
            if (now - entry.touchedAt >= this.#ttlMs)
                this.#evict(key, "ttl");
        }
        while (this.#entries.size > this.#maxEntries) {
            const oldest = this.#entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.#evict(oldest, "capacity");
        }
    }
    get(key) {
        const now = this.#now();
        this.prune(now);
        const entry = this.#entries.get(key);
        if (!entry)
            return undefined;
        this.#entries.delete(key);
        this.#entries.set(key, { value: entry.value, touchedAt: now });
        return entry.value;
    }
    set(key, value) {
        const now = this.#now();
        this.prune(now);
        this.#entries.delete(key);
        this.#entries.set(key, { value, touchedAt: now });
        this.prune(now);
        return this;
    }
    delete(key) {
        return this.#entries.delete(key);
    }
    keys() {
        this.prune();
        return [...this.#entries.keys()];
    }
    stats() {
        this.prune();
        return {
            size: this.#entries.size,
            ttlEvictions: this.#ttlEvictions,
            capacityEvictions: this.#capacityEvictions,
        };
    }
}
