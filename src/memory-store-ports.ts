/** Canonical contracts at the boundary between memory use-cases and storage. */
export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: "preference" | "fact" | "decision" | "entity" | "other" | "reflection";
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemoryTruthStats {
  totalCount: number;
  scopeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  lifecycleScopeCounts: Record<string, {
    recallable: number;
    archived: number;
    inactive: number;
  }>;
  lifecycleProjection?: {
    ok: boolean;
    status: string;
    reason: string;
    truthRows: number;
    projectedRows: number;
    stateProjectedRows: number | null;
    repairRequired: boolean;
  };
}

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
  vectorBackend?: "lancedb" | "sqlite-bruteforce";
}

export interface MetadataPatch {
  [key: string]: unknown;
}

export interface AtomicSupersedeInput {
  text: string;
  vector: number[];
  category: MemoryEntry["category"];
  importance: number;
  buildMetadata(context: {
    oldEntry: MemoryEntry;
    newId: string;
    now: number;
  }): { oldMetadata: string; newMetadata: string; factKey: string };
}

export interface TruthFtsReport {
  truthRows: number;
  ftsRows: number;
  staleFtsRows: number;
  missingFtsRows: number;
  duplicateFtsExtraRows: number;
  healthy: boolean;
  reason?: string;
}

export interface VectorRepairDebtReport {
  pending: number;
  oldestCreatedAt: number | null;
  latestUpdatedAt: number | null;
}

export interface MemoryStoreDiagnostics {
  sqlTruth: {
    available: boolean;
    path: string | null;
    count: number | null;
    fts: TruthFtsReport | null;
    errorCode:
      | "SQL_TRUTH_UNAVAILABLE"
      | "SQL_TRUTH_MIGRATION_REQUIRED"
      | "SQL_TRUTH_RUNTIME_FAILURE"
      | null;
    error: string | null;
  };
  fts: { available: boolean; lastError: string | null };
  vectorCompanion: {
    ready: boolean;
    needsRepair: boolean;
    message: string | null;
    configuredDimension: number;
    backend: "lancedb" | "sqlite-bruteforce";
    repairDebt: VectorRepairDebtReport | null;
    scanBudgetExhaustions: number;
    lastScanBudgetExhaustedAt: number | null;
  };
}

export interface VectorCompanionEmbedder {
  embedPassage(text: string): Promise<number[]>;
  embedBatchPassage?(texts: string[]): Promise<number[][]>;
}

export interface VectorCompanionRebuildOptions {
  batchSize?: number;
  limit?: number;
  dryRun?: boolean;
  fullRebuild?: boolean;
}

export interface VectorCompanionRebuildResult {
  dryRun: boolean;
  fullRebuild: boolean;
  truthCount: number;
  vectorRowsBefore: number;
  staleVectorRowsDeleted: number;
  processed: number;
  rebuilt: number;
  skipped: number;
  errors: string[];
}

export interface VectorCompanionDriftReport {
  truthCount: number;
  checkedTruthRows: number;
  vectorRows: number;
  missingVectorRows: number;
  staleVectorRows: number;
  truncated: boolean;
  repairHint: string | null;
}

export interface MemoryTruthPort {
  store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry>;
  importEntry(entry: MemoryEntry): Promise<MemoryEntry>;
  hasId(id: string): Promise<boolean>;
  getById(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null>;
  delete(id: string, scopeFilter?: string[]): Promise<boolean>;
  list(scopeFilter?: string[], category?: string, limit?: number, offset?: number): Promise<MemoryEntry[]>;
  stats(scopeFilter?: string[]): Promise<MemoryTruthStats>;
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
  ): Promise<MemoryEntry | null>;
  supersede(id: string, replacement: AtomicSupersedeInput, scopeFilter?: string[]): Promise<MemoryEntry>;
  patchMetadata(id: string, patch: MetadataPatch, scopeFilter?: string[]): Promise<MemoryEntry | null>;
  bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number>;
  getSqlTruthDb(): Promise<any | null>;
}

export interface MemoryRetrievalPort {
  vectorSearch(
    vector: number[],
    limit?: number,
    minScore?: number,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]>;
  bm25Search(
    query: string,
    limit?: number,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): Promise<MemorySearchResult[]>;
  fetchForCompaction(maxTimestamp: number, scopeFilter?: string[], limit?: number): Promise<MemoryEntry[]>;
}

export interface MemoryProjectionPort {
  readonly dbPath: string;
  readonly hasFtsSupport: boolean;
  readonly lastFtsError: string | null;
  deleteVectorCompanion(id: string, operation?: string): Promise<boolean>;
  getVectorEntryById(id: string): Promise<MemoryEntry | null>;
  getFtsStatus(): { available: boolean; lastError: string | null };
  verifyFilePrivacy(): Promise<void>;
  getDiagnostics(): MemoryStoreDiagnostics;
  getVectorCompanionStatus(): {
    ready: boolean;
    needsRepair: boolean;
    message: string | null;
    backend: "lancedb" | "sqlite-bruteforce";
    repairDebt: VectorRepairDebtReport | null;
    scanBudgetExhaustions: number;
    lastScanBudgetExhaustedAt: number | null;
  };
  getVectorCompanionDriftReport(maxTruthRows?: number): Promise<VectorCompanionDriftReport>;
  getVectorScopeCounts(): Promise<Record<string, number>>;
  rebuildVectorCompanion(
    embedder: VectorCompanionEmbedder,
    options?: VectorCompanionRebuildOptions,
  ): Promise<VectorCompanionRebuildResult>;
  rebuildFtsIndex(): Promise<{ success: boolean; error?: string }>;
}

export interface MemoryTransactionPort {
  reopenAfterRecovery(): Promise<void>;
  close(): Promise<void>;
}

/** Composite implementation contract consumed by the compatibility facade. */
export interface MemoryStorePorts
  extends MemoryTruthPort, MemoryRetrievalPort, MemoryProjectionPort, MemoryTransactionPort {}
