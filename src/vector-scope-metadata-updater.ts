import type * as LanceDB from "@lancedb/lancedb";
import { loadLanceDB } from "./lancedb-loader.js";
import { withMemoryWriteLock } from "./memory-write-lock.js";
import { SqliteBruteForceVectorStore } from "./sqlite-vector-store.js";
import { validateStoragePath } from "./storage-path.js";

const TABLE_NAME = "memories";

export interface VectorScopeMetadataUpdaterPort {
  getScope(id: string): Promise<string | null>;
  updateScope(id: string, expectedPreviousScope: string, targetScope: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Mutates only the vector companion's scope column. It never reads or rewrites
 * memory text, metadata, or vector values and never invokes an embedder.
 */
export class VectorScopeMetadataUpdater implements VectorScopeMetadataUpdaterPort {
  private lanceDb: LanceDB.Connection | null = null;
  private lanceTable: LanceDB.Table | null = null;
  private sqliteStore: SqliteBruteForceVectorStore | null = null;

  constructor(private readonly config: {
    dbPath: string;
    vectorDim: number;
    vectorBackend: "lancedb" | "sqlite-bruteforce";
  }) {
    if (!Number.isInteger(config.vectorDim) || config.vectorDim <= 0) {
      throw new Error("vector scope metadata updater requires a positive vector dimension");
    }
  }

  async updateScope(
    id: string,
    expectedPreviousScope: string,
    targetScope: string,
  ): Promise<boolean> {
    for (const value of [id, expectedPreviousScope, targetScope]) {
      if (!value || value !== value.trim()) {
        throw new Error("vector scope metadata update requires explicit trimmed values");
      }
    }
    await this.ensureOpen();
    return withMemoryWriteLock(this.config.dbPath, async () => {
      const current = await this.getScope(id);
      if (current === targetScope) return false;
      if (current !== expectedPreviousScope) {
        throw new Error("vector scope metadata update found an unexpected previous scope");
      }
      const rowsUpdated = this.sqliteStore
        ? this.sqliteStore.updateScope(id, expectedPreviousScope, targetScope)
        : Number((await this.lanceTable!.update({
          where: `id = '${escapeSqlLiteral(id)}' AND scope = '${escapeSqlLiteral(expectedPreviousScope)}'`,
          values: { scope: targetScope },
        })).rowsUpdated);
      if (rowsUpdated !== 1 || await this.getScope(id) !== targetScope) {
        throw new Error("vector scope metadata update did not converge exactly one row");
      }
      return true;
    });
  }

  async close(): Promise<void> {
    try {
      this.sqliteStore?.close();
      await (this.lanceTable as any)?.close?.();
      await (this.lanceDb as any)?.close?.();
    } finally {
      this.sqliteStore = null;
      this.lanceTable = null;
      this.lanceDb = null;
    }
  }

  async getScope(id: string): Promise<string | null> {
    if (!id || id !== id.trim()) {
      throw new Error("vector scope metadata read requires one explicit trimmed id");
    }
    await this.ensureOpen();
    if (this.sqliteStore) return this.sqliteStore.getById(id)?.scope ?? null;
    const rows = await this.lanceTable!.query()
      .where(`id = '${escapeSqlLiteral(id)}'`)
      .select(["scope"])
      .limit(2)
      .toArray();
    if (rows.length > 1) throw new Error("vector scope metadata read found duplicate companion rows");
    return rows.length === 1 ? String(rows[0].scope ?? "global") : null;
  }

  private async ensureOpen(): Promise<void> {
    if (this.sqliteStore || this.lanceTable) return;
    const dbPath = validateStoragePath(this.config.dbPath);
    if (this.config.vectorBackend === "sqlite-bruteforce") {
      this.sqliteStore = new SqliteBruteForceVectorStore(dbPath, this.config.vectorDim);
      this.sqliteStore.open();
      return;
    }
    const lancedb = await loadLanceDB();
    this.lanceDb = await lancedb.connect(dbPath);
    this.lanceTable = await this.lanceDb.openTable(TABLE_NAME);
  }

}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
