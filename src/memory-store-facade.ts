import type {
  AtomicSupersedeInput,
  MemoryEntry,
  MemoryProjectionPort,
  MemorySearchResult,
  MemoryStoreDiagnostics,
  MemoryStorePorts,
  MemoryTruthStats,
  MetadataPatch,
  VectorCompanionDriftReport,
  VectorCompanionEmbedder,
  VectorCompanionRebuildOptions,
  VectorCompanionRebuildResult,
} from "./memory-store-ports.js";

/**
 * Compatibility facade for the historical `MemoryStore` API.
 *
 * Application and adapter code can continue to depend on this stable class,
 * while storage behavior is supplied through explicit truth, retrieval,
 * projection, and transaction ports. The optional port injection exists for
 * characterization tests and future adapter replacement; production builds
 * use the current SQL-truth/vector-companion runtime.
 */
export class MemoryStoreFacade implements MemoryStorePorts {
  constructor(protected readonly ports: MemoryStorePorts) {}

  get dbPath(): string { return this.ports.dbPath; }
  get hasFtsSupport(): boolean { return this.ports.hasFtsSupport; }
  get lastFtsError(): string | null { return this.ports.lastFtsError; }

  reopenAfterRecovery(): Promise<void> { return this.ports.reopenAfterRecovery(); }
  close(): Promise<void> { return this.ports.close(); }
  store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry> {
    return this.ports.store(entry);
  }
  importEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    return this.ports.importEntry(entry);
  }
  hasId(id: string): Promise<boolean> { return this.ports.hasId(id); }
  getById(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null> {
    return this.ports.getById(id, scopeFilter);
  }
  vectorSearch(
    vector: number[],
    limit?: number,
    minScore?: number,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]> {
    return this.ports.vectorSearch(vector, limit, minScore, scopeFilter, options);
  }
  bm25Search(
    query: string,
    limit?: number,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]> {
    return this.ports.bm25Search(query, limit, scopeFilter, options);
  }
  deleteVectorCompanion(id: string, operation?: string): Promise<boolean> {
    return this.ports.deleteVectorCompanion(id, operation);
  }
  delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    return this.ports.delete(id, scopeFilter);
  }
  list(
    scopeFilter?: string[],
    category?: string,
    limit?: number,
    offset?: number,
  ): Promise<MemoryEntry[]> {
    return this.ports.list(scopeFilter, category, limit, offset);
  }
  stats(scopeFilter?: string[]): Promise<MemoryTruthStats> {
    return this.ports.stats(scopeFilter);
  }
  update(
    id: string,
    updates: {
      text?: string;
      vector?: number[];
      importance?: number;
      category?: MemoryEntry["category"];
      metadata?: string;
    },
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    return this.ports.update(id, updates, scopeFilter);
  }
  supersede(
    id: string,
    replacement: AtomicSupersedeInput,
    scopeFilter?: string[],
  ): Promise<MemoryEntry> {
    return this.ports.supersede(id, replacement, scopeFilter);
  }
  patchMetadata(
    id: string,
    patch: MetadataPatch,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    return this.ports.patchMetadata(id, patch, scopeFilter);
  }
  bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number> {
    return this.ports.bulkDelete(scopeFilter, beforeTimestamp);
  }
  getSqlTruthDb(): Promise<any | null> { return this.ports.getSqlTruthDb(); }
  getFtsStatus(): { available: boolean; lastError: string | null } {
    return this.ports.getFtsStatus();
  }
  verifyFilePrivacy(): Promise<void> { return this.ports.verifyFilePrivacy(); }
  getDiagnostics(): MemoryStoreDiagnostics { return this.ports.getDiagnostics(); }
  getVectorCompanionStatus(): ReturnType<MemoryProjectionPort["getVectorCompanionStatus"]> {
    return this.ports.getVectorCompanionStatus();
  }
  getVectorCompanionDriftReport(maxTruthRows?: number): Promise<VectorCompanionDriftReport> {
    return this.ports.getVectorCompanionDriftReport(maxTruthRows);
  }
  getVectorScopeCounts(): Promise<Record<string, number>> {
    return this.ports.getVectorScopeCounts();
  }
  rebuildVectorCompanion(
    embedder: VectorCompanionEmbedder,
    options?: VectorCompanionRebuildOptions,
  ): Promise<VectorCompanionRebuildResult> {
    return this.ports.rebuildVectorCompanion(embedder, options);
  }
  rebuildFtsIndex(): Promise<{ success: boolean; error?: string }> {
    return this.ports.rebuildFtsIndex();
  }
  fetchForCompaction(
    maxTimestamp: number,
    scopeFilter?: string[],
    limit?: number,
  ): Promise<MemoryEntry[]> {
    return this.ports.fetchForCompaction(maxTimestamp, scopeFilter, limit);
  }
}
