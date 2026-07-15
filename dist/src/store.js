/**
 * LanceDB Storage Layer with Multi-Scope Support
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, accessSync, constants, mkdirSync, realpathSync, lstatSync, } from "node:fs";
import { dirname, join } from "node:path";
import { buildSmartMetadata, isMemoryActiveAt, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import { SqlTruthStore, } from "./sql-truth-store.js";
import { SqliteBruteForceVectorStore } from "./sqlite-vector-store.js";
import { diagnosticErrorSummary, diagnosticIdentifier } from "./diagnostic-redaction.js";
import { ensurePrivateDirectory } from "./file-privacy.js";
// ============================================================================
// LanceDB Dynamic Import
// ============================================================================
let lancedbImportPromise = null;
const require = createRequire(import.meta.url);
// =========================================================================
// Cross-Process File Lock (proper-lockfile)
// =========================================================================
let lockfileModule = null;
async function loadLockfile() {
    if (!lockfileModule) {
        lockfileModule = await import("proper-lockfile");
    }
    return lockfileModule;
}
export const loadLanceDB = async () => {
    if (!lancedbImportPromise) {
        // Use require() for CommonJS modules on Windows to avoid ESM URL scheme issues
        lancedbImportPromise = Promise.resolve(require("@lancedb/lancedb"));
    }
    try {
        return await lancedbImportPromise;
    }
    catch (err) {
        throw new Error(`CLAWLORE_LANCEDB_LOAD_FAILED: ${diagnosticErrorSummary(err)}`, { cause: err });
    }
};
// ============================================================================
// Utility Functions
// ============================================================================
function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
function escapeSqlLiteral(value) {
    return value.replace(/'/g, "''");
}
function normalizeSearchText(value) {
    return value.toLowerCase().trim();
}
function isExplicitDenyAllScopeFilter(scopeFilter) {
    return Array.isArray(scopeFilter) && scopeFilter.length === 0;
}
function scoreLexicalHit(query, candidates) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery)
        return 0;
    let score = 0;
    for (const candidate of candidates) {
        const normalized = normalizeSearchText(candidate.text);
        if (!normalized)
            continue;
        if (normalized.includes(normalizedQuery)) {
            score = Math.max(score, Math.min(0.95, 0.72 + normalizedQuery.length * 0.02) * candidate.weight);
        }
    }
    return score;
}
// ============================================================================
// Storage Path Validation
// ============================================================================
/**
 * Validate and prepare the storage directory before LanceDB connection.
 * Resolves symlinks, creates missing directories, and checks write permissions.
 * Returns the resolved absolute path on success, or throws a descriptive error.
 */
export function validateStoragePath(dbPath) {
    let resolvedPath = dbPath;
    // Resolve symlinks (including dangling symlinks)
    try {
        const stats = lstatSync(dbPath);
        if (stats.isSymbolicLink()) {
            try {
                resolvedPath = realpathSync(dbPath);
            }
            catch (err) {
                throw new Error(`CLAWLORE_STORAGE_PATH_INVALID: path=${diagnosticIdentifier(dbPath)} dangling_symlink ${diagnosticErrorSummary(err)}`);
            }
        }
    }
    catch (err) {
        // Missing path is OK (it will be created below)
        if (err?.code === "ENOENT") {
            // no-op
        }
        else if (typeof err?.message === "string" &&
            err.message.includes("symlink whose target does not exist")) {
            throw err;
        }
        else {
            // Other lstat failures — continue with original path
        }
    }
    // Create directory if it doesn't exist
    try {
        ensurePrivateDirectory(resolvedPath);
    }
    catch (err) {
        throw new Error(`CLAWLORE_STORAGE_PRIVATE_DIRECTORY_REQUIRED: path=${diagnosticIdentifier(resolvedPath)} parent=${diagnosticIdentifier(dirname(resolvedPath))} ${diagnosticErrorSummary(err)}`);
    }
    // Check write permissions
    try {
        accessSync(resolvedPath, constants.W_OK);
    }
    catch (err) {
        throw new Error(`CLAWLORE_STORAGE_NOT_WRITABLE: path=${diagnosticIdentifier(resolvedPath)} ${diagnosticErrorSummary(err)}`);
    }
    return resolvedPath;
}
// ============================================================================
// Memory Store
// ============================================================================
const TABLE_NAME = "memories";
export class MemoryStore {
    config;
    db = null;
    table = null;
    sqlTruthStore = null;
    sqliteVectorStore = null;
    initPromise = null;
    initializationFailure = null;
    initialized = false;
    ftsIndexCreated = false;
    updateQueue = Promise.resolve();
    vectorCompanionError = null;
    sqlTruthErrorCode = null;
    sqlTruthError = null;
    scanBudgetExhaustions = 0;
    lastScanBudgetExhaustedAt = null;
    constructor(config) {
        this.config = config;
    }
    async runWithFileLock(fn) {
        const lockfile = await loadLockfile();
        const lockPath = join(this.config.dbPath, ".memory-write.lock");
        if (!existsSync(lockPath)) {
            try {
                mkdirSync(dirname(lockPath), { recursive: true });
            }
            catch { }
            try {
                const { writeFileSync } = await import("node:fs");
                writeFileSync(lockPath, "", { flag: "wx" });
            }
            catch { }
        }
        const release = await lockfile.lock(lockPath, {
            retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2000 },
            stale: 10000,
        });
        try {
            return await fn();
        }
        finally {
            await release();
        }
    }
    get dbPath() {
        return this.config.dbPath;
    }
    async ensureInitialized() {
        if (this.initialized) {
            return;
        }
        if (this.initializationFailure) {
            throw this.initializationFailure;
        }
        if (this.initPromise) {
            return this.initPromise;
        }
        this.initPromise = this.doInitialize().catch(async (err) => {
            await this.releaseInitializationResources();
            const stableError = err instanceof Error ? err : new Error(String(err));
            this.initializationFailure = stableError;
            throw stableError;
        });
        return this.initPromise;
    }
    async releaseInitializationResources() {
        try {
            this.sqlTruthStore?.close();
        }
        catch { }
        try {
            this.sqliteVectorStore?.close();
        }
        catch { }
        try {
            await this.table?.close?.();
        }
        catch { }
        try {
            await this.db?.close?.();
        }
        catch { }
        this.sqlTruthStore = null;
        this.sqliteVectorStore = null;
        this.table = null;
        this.db = null;
        this.initialized = false;
        this.ftsIndexCreated = false;
    }
    /** Explicit recovery boundary after an operator has restored truth storage. */
    async reopenAfterRecovery() {
        await this.releaseInitializationResources();
        this.initPromise = null;
        this.initializationFailure = null;
        this.sqlTruthErrorCode = null;
        this.sqlTruthError = null;
        await this.ensureInitialized();
    }
    /** Release local store handles. Primarily used by restart/canary tests. */
    async close() {
        await this.releaseInitializationResources();
        this.initPromise = null;
    }
    async doInitialize() {
        if (this.config.vectorBackend === "sqlite-bruteforce") {
            const sqliteVectorStore = new SqliteBruteForceVectorStore(this.config.dbPath, this.config.vectorDim);
            sqliteVectorStore.open();
            this.sqliteVectorStore = sqliteVectorStore;
            await this.initializeSqlTruthStore(sqliteVectorStore.hasRows());
            this.vectorCompanionError = null;
            this.initialized = true;
            return;
        }
        const lancedb = await loadLanceDB();
        let db;
        try {
            db = await lancedb.connect(this.config.dbPath);
        }
        catch (err) {
            throw new Error(`CLAWLORE_LANCEDB_OPEN_FAILED: path=${diagnosticIdentifier(this.config.dbPath)} ${diagnosticErrorSummary(err)}`);
        }
        let table;
        // Idempotent table init: try openTable first, create only if missing,
        // and handle the race where tableNames() misses an existing table but
        // createTable then sees it (LanceDB eventual consistency).
        try {
            table = await db.openTable(TABLE_NAME);
            // Migrate legacy tables: add missing columns for backward compatibility
            try {
                const schema = await table.schema();
                const fieldNames = new Set(schema.fields.map((f) => f.name));
                const missingColumns = [];
                if (!fieldNames.has("scope")) {
                    missingColumns.push({ name: "scope", valueSql: "'global'" });
                }
                if (!fieldNames.has("timestamp")) {
                    missingColumns.push({ name: "timestamp", valueSql: "CAST(0 AS DOUBLE)" });
                }
                if (!fieldNames.has("metadata")) {
                    missingColumns.push({ name: "metadata", valueSql: "'{}'" });
                }
                if (missingColumns.length > 0) {
                    console.warn(`clawlore: migrating legacy table — adding columns: ${missingColumns.map((c) => c.name).join(", ")}`);
                    await table.addColumns(missingColumns);
                    console.log(`clawlore: migration complete — ${missingColumns.length} column(s) added`);
                }
            }
            catch (err) {
                const msg = String(err);
                if (msg.includes("already exists")) {
                    // Concurrent initialization race — another process already added the columns
                    console.log("clawlore: migration columns already exist (concurrent init)");
                }
                else {
                    console.warn(`clawlore: could not check/migrate table schema: ${diagnosticErrorSummary(err)}`);
                }
            }
        }
        catch (_openErr) {
            // Table doesn't exist yet — create it
            const schemaEntry = {
                id: "__schema__",
                text: "",
                vector: Array.from({ length: this.config.vectorDim }).fill(0),
                category: "other",
                scope: "global",
                importance: 0,
                timestamp: 0,
                metadata: "{}",
            };
            try {
                table = await db.createTable(TABLE_NAME, [schemaEntry]);
                await table.delete('id = "__schema__"');
            }
            catch (createErr) {
                // Race: another caller (or eventual consistency) created the table
                // between our failed openTable and this createTable — just open it.
                if (String(createErr).includes("already exists")) {
                    table = await db.openTable(TABLE_NAME);
                }
                else {
                    throw createErr;
                }
            }
        }
        // Validate vector dimensions
        // Note: LanceDB returns Arrow Vector objects, not plain JS arrays.
        // Array.isArray() returns false for Arrow Vectors, so use .length instead.
        const sample = await table.query().limit(1).toArray();
        if (sample.length > 0 && sample[0]?.vector?.length) {
            const existingDim = sample[0].vector.length;
            if (existingDim !== this.config.vectorDim) {
                throw new Error(`Vector dimension mismatch: table=${existingDim}, config=${this.config.vectorDim}. Create a new table/dbPath or set matching embedding.dimensions.`);
            }
        }
        // Create FTS index for BM25 search (graceful fallback if unavailable)
        try {
            await this.createFtsIndex(table);
            this.ftsIndexCreated = true;
        }
        catch (err) {
            console.warn(`Failed to create FTS index, falling back to vector-only search: ${diagnosticErrorSummary(err)}`);
            this.ftsIndexCreated = false;
        }
        this.db = db;
        this.table = table;
        const companionProbe = await table.query().select(["id"]).limit(1).toArray();
        const hasCompanionRows = companionProbe.some((row) => row?.id && row.id !== "__schema__");
        await this.initializeSqlTruthStore(hasCompanionRows);
        this.initialized = true;
    }
    rowToEntry(row, includeVector) {
        const rawVector = row.vector;
        return {
            id: row.id,
            text: row.text,
            vector: includeVector && rawVector ? Array.from(rawVector) : [],
            category: row.category,
            scope: row.scope ?? "global",
            importance: Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: row.metadata || "{}",
        };
    }
    async initializeSqlTruthStore(hasCompanionRows) {
        let truth = null;
        const truthPath = join(this.config.dbPath, "memory.sqlite3");
        // A companion with rows but no SQL authority is an outage or an explicit
        // legacy-migration situation. Ordinary startup must never recreate truth
        // from vectors because stale deleted/superseded rows can be resurrected.
        const truthExists = existsSync(truthPath);
        if (!truthExists && hasCompanionRows) {
            this.sqlTruthStore = null;
            this.sqlTruthErrorCode = "SQL_TRUTH_MIGRATION_REQUIRED";
            this.sqlTruthError = "SQL truth is missing while vector companion data exists";
            throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_REQUIRED: restore memory.sqlite3 from a verified backup; companion-to-truth recovery is unsupported and vector startup import is forbidden");
        }
        try {
            truth = new SqlTruthStore(truthPath);
            const inspection = SqlTruthStore.inspectAuthority(truthPath);
            if (inspection.status === "untrusted" || inspection.status === "legacy") {
                this.sqlTruthErrorCode = "SQL_TRUTH_MIGRATION_REQUIRED";
                throw new Error(`CLAWLORE_SQL_TRUTH_AUTHORITY_REQUIRED: ${inspection.reason}`);
            }
            truth.open({
                allowCreate: !truthExists && !hasCompanionRows,
            });
            this.sqlTruthStore = truth;
            this.sqlTruthErrorCode = null;
            this.sqlTruthError = null;
            console.log(`clawlore: SQL truth companion ready (${truth.count()} rows, path=${diagnosticIdentifier(truth.path)})`);
        }
        catch (err) {
            try {
                truth?.close();
            }
            catch { }
            this.sqlTruthStore = null;
            if (this.sqlTruthErrorCode !== "SQL_TRUTH_MIGRATION_REQUIRED") {
                this.sqlTruthErrorCode = "SQL_TRUTH_UNAVAILABLE";
            }
            this.sqlTruthError = diagnosticErrorSummary(err);
            console.error(`clawlore: SQL truth initialization failed; memory operations are fail-closed: ${this.sqlTruthError}`);
            if (this.sqlTruthErrorCode === "SQL_TRUTH_MIGRATION_REQUIRED") {
                throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_REQUIRED: restore the verified SQL truth authority before retrying; companion import is unsupported", { cause: err });
            }
            throw new Error(`CLAWLORE_SQL_TRUTH_UNAVAILABLE: SQL truth initialization failed; run doctor and restore the truth database before retrying`, { cause: err });
        }
    }
    syncSqlTruthUpsert(entry) {
        if (!this.sqlTruthStore)
            return;
        try {
            this.sqlTruthStore.upsert(entry);
        }
        catch (err) {
            console.warn(`clawlore: SQL truth upsert failed; LanceDB row preserved: ${diagnosticErrorSummary(err)}`);
        }
    }
    syncSqlTruthDelete(id) {
        if (!this.sqlTruthStore)
            return;
        try {
            this.sqlTruthStore.delete(id);
        }
        catch (err) {
            console.warn(`clawlore: SQL truth delete failed; LanceDB delete already applied: ${diagnosticErrorSummary(err)}`);
        }
    }
    writeSqlTruthUpsert(entry, operation) {
        if (!this.sqlTruthStore) {
            throw new Error("CLAWLORE_SQL_TRUTH_UNAVAILABLE: write denied because SQL truth is unavailable");
        }
        this.sqlTruthStore.upsertWithVectorIntent(entry, operation);
    }
    writeSqlTruthDelete(id, operation) {
        if (!this.sqlTruthStore) {
            throw new Error("CLAWLORE_SQL_TRUTH_UNAVAILABLE: delete denied because SQL truth is unavailable");
        }
        this.sqlTruthStore.deleteWithVectorIntent(id, operation);
    }
    markVectorCompanionNeedsRepair(memoryId, action, operation, err) {
        const message = diagnosticErrorSummary(err);
        this.vectorCompanionError = `${operation}: ${message}`;
        try {
            this.sqlTruthStore?.recordVectorRepairDebt({
                memoryId,
                action,
                operation,
                error: message,
            });
        }
        catch (debtError) {
            this.vectorCompanionError = `${operation}: ${message}; repair debt persistence failed: ${diagnosticErrorSummary(debtError)}`;
        }
        console.warn(`clawlore: vector companion ${operation} failed; SQL truth preserved, repair required: ${message}`);
    }
    clearVectorCompanionRepair(memoryId) {
        try {
            this.sqlTruthStore?.clearVectorRepairDebt(memoryId);
            const pending = this.sqlTruthStore?.vectorRepairDebtReport().pending ?? 0;
            if (pending === 0)
                this.vectorCompanionError = null;
        }
        catch (err) {
            this.vectorCompanionError = `repair debt cleanup failed: ${diagnosticErrorSummary(err)}`;
        }
    }
    async addVectorCompanion(entry, operation, clearDebtOnSuccess = true) {
        try {
            if (this.sqliteVectorStore) {
                this.sqliteVectorStore.upsert(entry);
            }
            else {
                await this.table.add([entry]);
            }
            if (clearDebtOnSuccess)
                this.clearVectorCompanionRepair(entry.id);
            return true;
        }
        catch (err) {
            this.markVectorCompanionNeedsRepair(entry.id, "upsert", operation, err);
            return false;
        }
    }
    async deleteVectorCompanionById(id, operation, clearDebtOnSuccess = true) {
        try {
            if (this.sqliteVectorStore) {
                this.sqliteVectorStore.delete(id);
            }
            else {
                await this.table.delete(`id = '${escapeSqlLiteral(id)}'`);
            }
            if (clearDebtOnSuccess)
                this.clearVectorCompanionRepair(id);
            return true;
        }
        catch (err) {
            this.markVectorCompanionNeedsRepair(id, "delete", operation, err);
            return false;
        }
    }
    async replaceVectorCompanion(entry, deleteOperation, addOperation) {
        const deleted = await this.deleteVectorCompanionById(entry.id, deleteOperation, false);
        const added = await this.addVectorCompanion(entry, addOperation, false);
        if (deleted && added) {
            this.clearVectorCompanionRepair(entry.id);
            return true;
        }
        if (added) {
            this.markVectorCompanionNeedsRepair(entry.id, "upsert", `${addOperation}-reconcile`, new Error("vector delete phase failed before a successful companion upsert"));
        }
        return false;
    }
    hydrateVectorResultsFromSql(results, scopeFilter, excludeInactive, limit) {
        if (!this.sqlTruthStore || results.length === 0)
            return results.slice(0, limit);
        const truthRows = this.sqlTruthStore.getByIds(results.map((result) => result.entry.id), scopeFilter);
        const truthById = new Map(truthRows.map((entry) => [entry.id, entry]));
        const hydrated = [];
        for (const result of results) {
            const truth = truthById.get(result.entry.id);
            if (!truth)
                continue;
            const entry = {
                ...truth,
                vector: result.entry.vector,
            };
            if (excludeInactive && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
                continue;
            }
            hydrated.push({ entry, score: result.score });
            if (hydrated.length >= limit)
                break;
        }
        return hydrated;
    }
    resolveSqlEntry(id, scopeFilter) {
        if (!this.sqlTruthStore)
            return null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const prefixRegex = /^[0-9a-f]{8,}$/i;
        const isFullId = uuidRegex.test(id);
        const isPrefix = !isFullId && prefixRegex.test(id);
        if (!isFullId && !isPrefix) {
            throw new Error(`Invalid memory ID format: ${id}`);
        }
        if (isFullId) {
            return this.sqlTruthStore.getById(id, scopeFilter);
        }
        const candidates = this.sqlTruthStore.findByPrefix(id, scopeFilter);
        if (candidates.length > 1) {
            throw new Error(`Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`);
        }
        return candidates[0] ?? null;
    }
    async getVectorEntryById(id) {
        if (this.sqliteVectorStore)
            return this.sqliteVectorStore.getById(id);
        if (!this.table)
            return null;
        const rows = await this.table
            .query()
            .where(`id = '${escapeSqlLiteral(id)}'`)
            .limit(1)
            .toArray();
        if (rows.length === 0)
            return null;
        return this.rowToEntry(rows[0], true);
    }
    async listVectorIds() {
        if (this.sqliteVectorStore)
            return this.sqliteVectorStore.listIds();
        if (!this.table)
            return [];
        const rows = await this.table.query().select(["id"]).toArray();
        return rows
            .map((row) => typeof row.id === "string" ? row.id : "")
            .filter((id) => id && id !== "__schema__");
    }
    listSqlTruthEntries(limit) {
        if (!this.sqlTruthStore)
            return [];
        const entries = [];
        const pageSize = 1_000;
        let offset = 0;
        while (limit === undefined || entries.length < limit) {
            const remaining = limit === undefined ? pageSize : Math.min(pageSize, limit - entries.length);
            if (remaining <= 0)
                break;
            const page = this.sqlTruthStore.list(undefined, undefined, remaining, offset);
            if (page.length === 0)
                break;
            entries.push(...page);
            offset += page.length;
        }
        return entries;
    }
    async embedRebuildBatch(embedder, batch, errors) {
        try {
            const vectors = typeof embedder.embedBatchPassage === "function"
                ? await embedder.embedBatchPassage(batch.map((entry) => entry.text))
                : await Promise.all(batch.map((entry) => embedder.embedPassage(entry.text)));
            return batch.flatMap((entry, index) => {
                const vector = vectors[index];
                if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
                    errors.push(`${entry.id}: embedding dimension mismatch (expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : "missing"})`);
                    return [];
                }
                return [{ ...entry, vector }];
            });
        }
        catch (batchError) {
            const rebuilt = [];
            errors.push(`batch embedding failed, falling back to single-row repair: ${diagnosticErrorSummary(batchError)}`);
            for (const entry of batch) {
                try {
                    const vector = await embedder.embedPassage(entry.text);
                    if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
                        errors.push(`${entry.id}: embedding dimension mismatch (expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : "missing"})`);
                        continue;
                    }
                    rebuilt.push({ ...entry, vector });
                }
                catch (err) {
                    errors.push(`${diagnosticIdentifier(entry.id)}: ${diagnosticErrorSummary(err)}`);
                }
            }
            return rebuilt;
        }
    }
    async createFtsIndex(table) {
        try {
            // Check if FTS index already exists
            const indices = await table.listIndices();
            const hasFtsIndex = indices?.some((idx) => idx.indexType === "FTS" || idx.columns?.includes("text"));
            if (!hasFtsIndex) {
                // LanceDB @lancedb/lancedb >=0.26: use Index.fts() config
                const lancedb = await loadLanceDB();
                await table.createIndex("text", {
                    config: lancedb.Index.fts(),
                });
            }
        }
        catch (err) {
            throw new Error(`CLAWLORE_FTS_INDEX_CREATE_FAILED: ${diagnosticErrorSummary(err)}`);
        }
    }
    async store(entry) {
        await this.ensureInitialized();
        const fullEntry = {
            ...entry,
            id: randomUUID(),
            timestamp: Date.now(),
            metadata: entry.metadata || "{}",
        };
        return this.runWithFileLock(async () => {
            this.writeSqlTruthUpsert(fullEntry, "store");
            await this.addVectorCompanion(fullEntry, "store");
            return fullEntry;
        });
    }
    /**
     * Import a pre-built entry while preserving its id/timestamp.
     * Used for re-embedding / migration / A/B testing across embedding models.
     * Intentionally separate from `store()` to keep normal writes simple.
     */
    async importEntry(entry) {
        await this.ensureInitialized();
        if (!entry.id || typeof entry.id !== "string") {
            throw new Error("importEntry requires a stable id");
        }
        const vector = entry.vector || [];
        if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
            throw new Error(`Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : "non-array"}`);
        }
        const full = {
            ...entry,
            scope: entry.scope || "global",
            importance: Number.isFinite(entry.importance) ? entry.importance : 0.7,
            timestamp: Number.isFinite(entry.timestamp)
                ? entry.timestamp
                : Date.now(),
            metadata: entry.metadata || "{}",
        };
        return this.runWithFileLock(async () => {
            this.writeSqlTruthUpsert(full, "import");
            await this.addVectorCompanion(full, "import");
            return full;
        });
    }
    async hasId(id) {
        await this.ensureInitialized();
        if (this.sqlTruthStore)
            return this.sqlTruthStore.getById(id) !== null;
        if (this.sqliteVectorStore)
            return false;
        const safeId = escapeSqlLiteral(id);
        const res = await this.table.query()
            .select(["id"])
            .where(`id = '${safeId}'`)
            .limit(1)
            .toArray();
        return res.length > 0;
    }
    async getById(id, scopeFilter) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return null;
        if (this.sqlTruthStore) {
            return this.sqlTruthStore.getById(id, scopeFilter);
        }
        if (this.sqliteVectorStore)
            return null;
        const safeId = escapeSqlLiteral(id);
        const rows = await this.table
            .query()
            .where(`id = '${safeId}'`)
            .limit(1)
            .toArray();
        if (rows.length === 0)
            return null;
        const row = rows[0];
        const rowScope = row.scope ?? "global";
        if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
            return null;
        }
        return {
            id: row.id,
            text: row.text,
            vector: Array.from(row.vector),
            category: row.category,
            scope: rowScope,
            importance: Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: row.metadata || "{}",
        };
    }
    async vectorSearch(vector, limit = 5, minScore = 0.3, scopeFilter, options) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return [];
        const safeLimit = clampInt(limit, 1, 20);
        // Over-fetch more aggressively when filtering inactive records,
        // because superseded historical rows can crowd out active ones.
        const inactiveFilter = options?.excludeInactive ?? false;
        const overFetchMultiplier = inactiveFilter ? 20 : 10;
        const initialFetchLimit = Math.min(Math.max(safeLimit * overFetchMultiplier, safeLimit), 200);
        const maxScanBudget = 5_000;
        if (this.sqliteVectorStore) {
            if (this.sqlTruthStore) {
                let fetchLimit = initialFetchLimit;
                while (true) {
                    const sqliteResults = this.sqliteVectorStore.search(vector, fetchLimit, minScore, undefined);
                    const hydrated = this.hydrateVectorResultsFromSql(sqliteResults, scopeFilter, inactiveFilter, safeLimit);
                    if (hydrated.length >= safeLimit ||
                        sqliteResults.length < fetchLimit ||
                        fetchLimit >= maxScanBudget) {
                        if (hydrated.length < safeLimit &&
                            fetchLimit >= maxScanBudget &&
                            sqliteResults.length >= fetchLimit) {
                            this.noteVectorScanBudgetExhausted();
                        }
                        return hydrated;
                    }
                    fetchLimit = Math.min(fetchLimit * 2, maxScanBudget);
                }
            }
            const sqliteResults = this.sqliteVectorStore.search(vector, initialFetchLimit, minScore, scopeFilter);
            const filtered = inactiveFilter
                ? sqliteResults.filter((result) => isMemoryActiveAt(parseSmartMetadata(result.entry.metadata, result.entry)))
                : sqliteResults;
            return filtered.slice(0, safeLimit);
        }
        let fetchLimit = initialFetchLimit;
        while (true) {
            let query = this.table.vectorSearch(vector).distanceType('cosine').limit(fetchLimit);
            if (!this.sqlTruthStore && scopeFilter && scopeFilter.length > 0) {
                const scopeConditions = scopeFilter
                    .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                    .join(" OR ");
                query = query.where(`(${scopeConditions}) OR scope IS NULL`);
            }
            const results = await query.toArray();
            const mapped = [];
            for (const row of results) {
                const distance = Number(row._distance ?? 0);
                const score = 1 / (1 + distance);
                if (score < minScore)
                    continue;
                const rowScope = row.scope ?? "global";
                if (!this.sqlTruthStore &&
                    scopeFilter &&
                    scopeFilter.length > 0 &&
                    !scopeFilter.includes(rowScope)) {
                    continue;
                }
                const entry = {
                    id: row.id,
                    text: row.text,
                    vector: row.vector,
                    category: row.category,
                    scope: rowScope,
                    importance: Number(row.importance),
                    timestamp: Number(row.timestamp),
                    metadata: row.metadata || "{}",
                };
                if (!this.sqlTruthStore && inactiveFilter && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
                    continue;
                }
                mapped.push({ entry, score });
                if (!this.sqlTruthStore && mapped.length >= safeLimit)
                    break;
            }
            if (!this.sqlTruthStore)
                return mapped;
            const hydrated = this.hydrateVectorResultsFromSql(mapped, scopeFilter, inactiveFilter, safeLimit);
            if (hydrated.length >= safeLimit ||
                results.length < fetchLimit ||
                fetchLimit >= maxScanBudget) {
                if (hydrated.length < safeLimit &&
                    fetchLimit >= maxScanBudget &&
                    results.length >= fetchLimit) {
                    this.noteVectorScanBudgetExhausted();
                }
                return hydrated;
            }
            fetchLimit = Math.min(fetchLimit * 2, maxScanBudget);
        }
    }
    async bm25Search(query, limit = 5, scopeFilter, options) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return [];
        const safeLimit = clampInt(limit, 1, 20);
        const inactiveFilter = options?.excludeInactive ?? false;
        // Over-fetch when filtering inactive records to avoid crowding
        const fetchLimit = inactiveFilter ? Math.min(safeLimit * 20, 200) : safeLimit;
        if (this.sqlTruthStore) {
            return this.searchSqlTruth(query, safeLimit, scopeFilter, options);
        }
        if (this.sqliteVectorStore)
            return [];
        if (!this.ftsIndexCreated) {
            return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
        }
        try {
            // Use FTS query type explicitly
            let searchQuery = this.table.search(query, "fts").limit(fetchLimit);
            // Apply scope filter if provided
            if (scopeFilter && scopeFilter.length > 0) {
                const scopeConditions = scopeFilter
                    .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                    .join(" OR ");
                searchQuery = searchQuery.where(`(${scopeConditions}) OR scope IS NULL`);
            }
            const results = await searchQuery.toArray();
            const mapped = [];
            for (const row of results) {
                const rowScope = row.scope ?? "global";
                // Double-check scope filter in application layer
                if (scopeFilter &&
                    scopeFilter.length > 0 &&
                    !scopeFilter.includes(rowScope)) {
                    continue;
                }
                // LanceDB FTS _score is raw BM25 (unbounded). Normalize with sigmoid.
                // LanceDB may return BigInt for numeric columns; coerce safely.
                const rawScore = row._score != null ? Number(row._score) : 0;
                const normalizedScore = rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / 5)) : 0.5;
                const entry = {
                    id: row.id,
                    text: row.text,
                    vector: row.vector,
                    category: row.category,
                    scope: rowScope,
                    importance: Number(row.importance),
                    timestamp: Number(row.timestamp),
                    metadata: row.metadata || "{}",
                };
                // Skip inactive (superseded) records when requested
                if (inactiveFilter && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
                    continue;
                }
                mapped.push({ entry, score: normalizedScore });
                if (mapped.length >= safeLimit)
                    break;
            }
            if (mapped.length > 0) {
                return mapped;
            }
            return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
        }
        catch (err) {
            console.warn(`BM25 search failed, falling back to empty results: ${diagnosticErrorSummary(err)}`);
            return this.lexicalFallbackSearch(query, safeLimit, scopeFilter, options);
        }
    }
    searchSqlTruth(query, limit, scopeFilter, options) {
        if (!this.sqlTruthStore)
            return [];
        try {
            const results = this.sqlTruthStore.search(query, limit, scopeFilter, options);
            this._lastFtsError = null;
            return results;
        }
        catch (err) {
            this._lastFtsError = `SQL_TRUTH_SEARCH_FAILED: ${diagnosticErrorSummary(err)}`;
            console.warn(`clawlore: SQL truth search failed; returning fail-closed empty results: ${diagnosticErrorSummary(err)}`);
            return [];
        }
    }
    async lexicalFallbackSearch(query, limit, scopeFilter, options) {
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return [];
        const trimmedQuery = query.trim();
        if (!trimmedQuery)
            return [];
        let searchQuery = this.table.query().select([
            "id",
            "text",
            "vector",
            "category",
            "scope",
            "importance",
            "timestamp",
            "metadata",
        ]);
        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map(scope => `scope = '${escapeSqlLiteral(scope)}'`)
                .join(" OR ");
            searchQuery = searchQuery.where(`(${scopeConditions}) OR scope IS NULL`);
        }
        const rows = await searchQuery.toArray();
        const matches = [];
        for (const row of rows) {
            const rowScope = row.scope ?? "global";
            if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
                continue;
            }
            const entry = {
                id: row.id,
                text: row.text,
                vector: row.vector,
                category: row.category,
                scope: rowScope,
                importance: Number(row.importance),
                timestamp: Number(row.timestamp),
                metadata: row.metadata || "{}",
            };
            const metadata = parseSmartMetadata(entry.metadata, entry);
            // Skip inactive (superseded) records when requested
            if (options?.excludeInactive && !isMemoryActiveAt(metadata)) {
                continue;
            }
            const score = scoreLexicalHit(trimmedQuery, [
                { text: entry.text, weight: 1 },
                { text: metadata.l0_abstract, weight: 0.98 },
                { text: metadata.l1_overview, weight: 0.92 },
                { text: metadata.l2_content, weight: 0.96 },
            ]);
            if (score <= 0)
                continue;
            matches.push({ entry, score });
        }
        return matches
            .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
            .slice(0, limit);
    }
    async deleteVectorCompanion(id, operation = "delete-vector-companion") {
        await this.ensureInitialized();
        return this.runWithFileLock(async () => {
            return this.deleteVectorCompanionById(id, operation);
        });
    }
    async delete(id, scopeFilter) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter)) {
            throw new Error(`Memory ${id} is outside accessible scopes`);
        }
        // Support both full UUID and short prefix (8+ hex chars)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const prefixRegex = /^[0-9a-f]{8,}$/i;
        const isFullId = uuidRegex.test(id);
        const isPrefix = !isFullId && prefixRegex.test(id);
        if (!isFullId && !isPrefix) {
            throw new Error(`Invalid memory ID format: ${id}`);
        }
        if (this.sqlTruthStore) {
            const sqlEntry = this.resolveSqlEntry(id, scopeFilter);
            if (!sqlEntry)
                return false;
            return this.runWithFileLock(async () => {
                this.writeSqlTruthDelete(sqlEntry.id, "delete");
                await this.deleteVectorCompanionById(sqlEntry.id, "delete");
                return true;
            });
        }
        let candidates;
        if (isFullId) {
            candidates = await this.table.query()
                .where(`id = '${id}'`)
                .limit(1)
                .toArray();
        }
        else {
            // Prefix match: fetch candidates and filter in app layer
            const all = await this.table.query()
                .select(["id", "scope"])
                .limit(1000)
                .toArray();
            candidates = all.filter((r) => r.id.startsWith(id));
            if (candidates.length > 1) {
                throw new Error(`Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`);
            }
        }
        if (candidates.length === 0) {
            return false;
        }
        const resolvedId = candidates[0].id;
        const rowScope = candidates[0].scope ?? "global";
        // Check scope permissions
        if (scopeFilter &&
            scopeFilter.length > 0 &&
            !scopeFilter.includes(rowScope)) {
            throw new Error(`Memory ${resolvedId} is outside accessible scopes`);
        }
        return this.runWithFileLock(async () => {
            await this.table.delete(`id = '${resolvedId}'`);
            this.syncSqlTruthDelete(resolvedId);
            return true;
        });
    }
    async list(scopeFilter, category, limit = 20, offset = 0) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter))
            return [];
        if (this.sqlTruthStore) {
            return this.sqlTruthStore.list(scopeFilter, category, limit, offset);
        }
        let query = this.table.query();
        // Build where conditions
        const conditions = [];
        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                .join(" OR ");
            conditions.push(`((${scopeConditions}) OR scope IS NULL)`);
        }
        if (category) {
            conditions.push(`category = '${escapeSqlLiteral(category)}'`);
        }
        if (conditions.length > 0) {
            query = query.where(conditions.join(" AND "));
        }
        // Fetch all matching rows (no pre-limit) so app-layer sort is correct across full dataset
        const results = await query
            .select([
            "id",
            "text",
            "category",
            "scope",
            "importance",
            "timestamp",
            "metadata",
        ])
            .toArray();
        return results
            .map((row) => ({
            id: row.id,
            text: row.text,
            vector: [], // Don't include vectors in list results for performance
            category: row.category,
            scope: row.scope ?? "global",
            importance: Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: row.metadata || "{}",
        }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(offset, offset + limit);
    }
    async stats(scopeFilter) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter)) {
            return {
                totalCount: 0,
                scopeCounts: {},
                categoryCounts: {},
            };
        }
        if (this.sqlTruthStore) {
            return this.sqlTruthStore.stats(scopeFilter);
        }
        let query = this.table.query();
        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                .join(" OR ");
            query = query.where(`((${scopeConditions}) OR scope IS NULL)`);
        }
        const results = await query.select(["scope", "category"]).toArray();
        const scopeCounts = {};
        const categoryCounts = {};
        for (const row of results) {
            const scope = row.scope ?? "global";
            const category = row.category;
            scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
            categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        }
        return {
            totalCount: results.length,
            scopeCounts,
            categoryCounts,
        };
    }
    async update(id, updates, scopeFilter) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter)) {
            throw new Error(`Memory ${id} is outside accessible scopes`);
        }
        if (this.sqlTruthStore) {
            return this.runWithFileLock(() => this.runSerializedUpdate(async () => {
                const original = this.resolveSqlEntry(id, scopeFilter);
                if (!original)
                    return null;
                const vectorOriginal = await this.getVectorEntryById(original.id).catch(() => null);
                const updated = {
                    ...original,
                    text: updates.text ?? original.text,
                    vector: updates.vector ?? vectorOriginal?.vector ?? original.vector,
                    category: updates.category ?? original.category,
                    importance: updates.importance ?? original.importance,
                    metadata: updates.metadata ?? original.metadata,
                };
                this.writeSqlTruthUpsert(updated, "update");
                if (Array.isArray(updated.vector) && updated.vector.length === this.config.vectorDim) {
                    await this.replaceVectorCompanion(updated, "update-delete-old-vector", "update-add-vector");
                }
                else {
                    this.markVectorCompanionNeedsRepair(updated.id, "upsert", "update", new Error(`missing ${this.config.vectorDim}-dimension vector for ${updated.id}`));
                }
                return updated;
            }));
        }
        return this.runWithFileLock(() => this.runSerializedUpdate(async () => {
            // Support both full UUID and short prefix (8+ hex chars), same as delete()
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            const prefixRegex = /^[0-9a-f]{8,}$/i;
            const isFullId = uuidRegex.test(id);
            const isPrefix = !isFullId && prefixRegex.test(id);
            if (!isFullId && !isPrefix) {
                throw new Error(`Invalid memory ID format: ${id}`);
            }
            let rows;
            if (isFullId) {
                const safeId = escapeSqlLiteral(id);
                rows = await this.table.query()
                    .where(`id = '${safeId}'`)
                    .limit(1)
                    .toArray();
            }
            else {
                // Prefix match
                const all = await this.table.query()
                    .select([
                    "id",
                    "text",
                    "vector",
                    "category",
                    "scope",
                    "importance",
                    "timestamp",
                    "metadata",
                ])
                    .limit(1000)
                    .toArray();
                rows = all.filter((r) => r.id.startsWith(id));
                if (rows.length > 1) {
                    throw new Error(`Ambiguous prefix "${id}" matches ${rows.length} memories. Use a longer prefix or full ID.`);
                }
            }
            if (rows.length === 0)
                return null;
            const row = rows[0];
            const rowScope = row.scope ?? "global";
            // Check scope permissions
            if (scopeFilter &&
                scopeFilter.length > 0 &&
                !scopeFilter.includes(rowScope)) {
                throw new Error(`Memory ${id} is outside accessible scopes`);
            }
            const original = {
                id: row.id,
                text: row.text,
                vector: Array.from(row.vector),
                category: row.category,
                scope: rowScope,
                importance: Number(row.importance),
                timestamp: Number(row.timestamp),
                metadata: row.metadata || "{}",
            };
            // Build updated entry, preserving original timestamp
            const updated = {
                ...original,
                text: updates.text ?? original.text,
                vector: updates.vector ?? original.vector,
                category: updates.category ?? original.category,
                scope: rowScope,
                importance: updates.importance ?? original.importance,
                timestamp: original.timestamp, // preserve original
                metadata: updates.metadata ?? original.metadata,
            };
            // LanceDB doesn't support in-place update; delete + re-add.
            // Serialize updates per store instance to avoid stale rollback races.
            // If the add fails after delete, attempt best-effort recovery without
            // overwriting a newer concurrent successful update.
            const rollbackCandidate = (await this.getById(original.id).catch(() => null)) ?? original;
            const resolvedId = escapeSqlLiteral(row.id);
            await this.table.delete(`id = '${resolvedId}'`);
            try {
                await this.table.add([updated]);
                this.syncSqlTruthUpsert(updated);
            }
            catch (addError) {
                const current = await this.getById(original.id).catch(() => null);
                if (current) {
                    throw new Error(`CLAWLORE_MEMORY_UPDATE_FAILED_PRESERVED: id=${diagnosticIdentifier(id)} ${diagnosticErrorSummary(addError)}`, { cause: addError });
                }
                try {
                    await this.table.add([rollbackCandidate]);
                    this.syncSqlTruthUpsert(rollbackCandidate);
                }
                catch (rollbackError) {
                    throw new Error(`CLAWLORE_MEMORY_UPDATE_ROLLBACK_FAILED: id=${diagnosticIdentifier(id)} write=${diagnosticErrorSummary(addError)} rollback=${diagnosticErrorSummary(rollbackError)}`, { cause: rollbackError });
                }
                throw new Error(`CLAWLORE_MEMORY_UPDATE_FAILED_RESTORED: id=${diagnosticIdentifier(id)} ${diagnosticErrorSummary(addError)}`, { cause: addError });
            }
            return updated;
        }));
    }
    async supersede(id, replacement, scopeFilter) {
        await this.ensureInitialized();
        if (isExplicitDenyAllScopeFilter(scopeFilter)) {
            throw new Error(`Memory ${id} is outside accessible scopes`);
        }
        if (!this.sqlTruthStore) {
            throw new Error("Atomic supersede requires the SQL truth store");
        }
        if (!Array.isArray(replacement.vector) || replacement.vector.length !== this.config.vectorDim) {
            throw new Error(`Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(replacement.vector) ? replacement.vector.length : "non-array"}`);
        }
        return this.runWithFileLock(() => this.runSerializedUpdate(async () => {
            const original = this.resolveSqlEntry(id, scopeFilter);
            if (!original)
                throw new Error(`Memory ${id} not found or outside accessible scopes`);
            const oldVectorEntry = await this.getVectorEntryById(original.id).catch(() => null);
            const now = Date.now();
            const newId = randomUUID();
            const metadata = replacement.buildMetadata({ oldEntry: original, newId, now });
            if (!metadata.factKey.trim())
                throw new Error("Atomic supersede requires a non-empty fact key");
            const invalidatedOld = {
                ...original,
                vector: oldVectorEntry?.vector ?? original.vector,
                metadata: metadata.oldMetadata,
            };
            const newEntry = {
                id: newId,
                timestamp: now,
                text: replacement.text,
                vector: replacement.vector,
                category: replacement.category,
                scope: original.scope,
                importance: replacement.importance,
                metadata: metadata.newMetadata,
            };
            this.sqlTruthStore.supersedeAtomically(invalidatedOld, newEntry, metadata.factKey);
            if (Array.isArray(invalidatedOld.vector) && invalidatedOld.vector.length === this.config.vectorDim) {
                await this.replaceVectorCompanion(invalidatedOld, "supersede-delete-old-vector", "supersede-add-invalidated-old-vector");
            }
            else {
                this.markVectorCompanionNeedsRepair(invalidatedOld.id, "upsert", "supersede-old", new Error(`missing ${this.config.vectorDim}-dimension vector for ${invalidatedOld.id}`));
            }
            await this.addVectorCompanion(newEntry, "supersede-add-new-vector");
            return newEntry;
        }));
    }
    async runSerializedUpdate(action) {
        const previous = this.updateQueue;
        let release;
        const lock = new Promise((resolve) => {
            release = resolve;
        });
        this.updateQueue = previous.then(() => lock);
        await previous;
        try {
            return await action();
        }
        finally {
            release?.();
        }
    }
    async patchMetadata(id, patch, scopeFilter) {
        const existing = await this.getById(id, scopeFilter);
        if (!existing)
            return null;
        const metadata = buildSmartMetadata(existing, patch);
        return this.update(id, { metadata: stringifySmartMetadata(metadata) }, scopeFilter);
    }
    async bulkDelete(scopeFilter, beforeTimestamp) {
        await this.ensureInitialized();
        const conditions = [];
        if (scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                .join(" OR ");
            conditions.push(`(${scopeConditions})`);
        }
        if (beforeTimestamp) {
            conditions.push(`timestamp < ${beforeTimestamp}`);
        }
        if (conditions.length === 0) {
            throw new Error("Bulk delete requires at least scope or timestamp filter for safety");
        }
        const whereClause = conditions.join(" AND ");
        return this.runWithFileLock(async () => {
            if (this.sqlTruthStore) {
                const deletedIds = this.sqlTruthStore.bulkDelete(scopeFilter, beforeTimestamp);
                for (const id of deletedIds) {
                    await this.deleteVectorCompanionById(id, "bulk-delete");
                }
                return deletedIds.length;
            }
            // Count first
            const countResults = await this.table.query().where(whereClause).toArray();
            const deleteCount = countResults.length;
            // Then delete
            if (deleteCount > 0) {
                await this.table.delete(whereClause);
                for (const row of countResults) {
                    if (row.id)
                        this.syncSqlTruthDelete(row.id);
                }
            }
            return deleteCount;
        });
    }
    get hasFtsSupport() {
        return this.ftsIndexCreated || this.sqlTruthStore !== null;
    }
    /**
     * Get the underlying SQL truth store database for Experience Kernel operations.
     * @internal
     */
    async getSqlTruthDb() {
        await this.ensureInitialized();
        if (!this.sqlTruthStore)
            return null;
        return this.sqlTruthStore.getDb();
    }
    /** Last FTS error for diagnostics */
    _lastFtsError = null;
    get lastFtsError() {
        return this._lastFtsError;
    }
    /** Get FTS index health status */
    getFtsStatus() {
        return {
            available: this.ftsIndexCreated || this.sqlTruthStore !== null,
            lastError: this._lastFtsError,
        };
    }
    async verifyFilePrivacy() {
        await this.ensureInitialized();
        if (!this.sqlTruthStore) {
            throw new Error("CLAWLORE_SQL_TRUTH_UNAVAILABLE: cannot verify file privacy");
        }
        this.sqlTruthStore.verifyFilePrivacy();
    }
    getDiagnostics() {
        let sqlTruth;
        if (!this.sqlTruthStore) {
            sqlTruth = {
                available: false,
                path: null,
                count: null,
                fts: null,
                errorCode: this.sqlTruthErrorCode,
                error: this.sqlTruthError,
            };
        }
        else {
            try {
                sqlTruth = {
                    available: true,
                    path: this.sqlTruthStore.path,
                    count: this.sqlTruthStore.count(),
                    fts: this.sqlTruthStore.ftsIntegrityReport(),
                    errorCode: null,
                    error: null,
                };
            }
            catch (err) {
                sqlTruth = {
                    available: false,
                    path: this.sqlTruthStore.path,
                    count: null,
                    fts: null,
                    errorCode: "SQL_TRUTH_RUNTIME_FAILURE",
                    error: diagnosticErrorSummary(err),
                };
            }
        }
        return {
            sqlTruth,
            fts: this.getFtsStatus(),
            vectorCompanion: this.getVectorCompanionStatus(),
        };
    }
    getVectorCompanionStatus() {
        let repairDebt = null;
        try {
            repairDebt = this.sqlTruthStore?.vectorRepairDebtReport() ?? null;
        }
        catch { }
        return {
            ready: this.vectorCompanionError === null && (repairDebt?.pending ?? 0) === 0,
            needsRepair: this.vectorCompanionError !== null || (repairDebt?.pending ?? 0) > 0,
            message: this.vectorCompanionError,
            configuredDimension: this.config.vectorDim,
            backend: this.sqliteVectorStore ? "sqlite-bruteforce" : "lancedb",
            repairDebt,
            scanBudgetExhaustions: this.scanBudgetExhaustions,
            lastScanBudgetExhaustedAt: this.lastScanBudgetExhaustedAt,
        };
    }
    noteVectorScanBudgetExhausted() {
        this.scanBudgetExhaustions++;
        this.lastScanBudgetExhaustedAt = Date.now();
        this.vectorCompanionError =
            "vector scan budget exhausted before enough SQL-valid rows were found; run vector companion repair";
    }
    async getVectorCompanionDriftReport(maxTruthRows = 100_000) {
        await this.ensureInitialized();
        const vectorIds = await this.listVectorIds();
        if (!this.sqlTruthStore) {
            return {
                truthCount: 0,
                checkedTruthRows: 0,
                vectorRows: vectorIds.length,
                missingVectorRows: 0,
                staleVectorRows: 0,
                truncated: false,
                repairHint: null,
            };
        }
        const truthCount = this.sqlTruthStore.count();
        const truthEntries = this.listSqlTruthEntries(maxTruthRows);
        const truthIds = new Set(truthEntries.map((entry) => entry.id));
        const vectorIdSet = new Set(vectorIds);
        const missingVectorRows = truthEntries.filter((entry) => !vectorIdSet.has(entry.id)).length;
        const truncated = truthCount > truthEntries.length;
        const staleVectorRows = truncated ? 0 : vectorIds.filter((id) => !truthIds.has(id)).length;
        const pendingRepairDebt = this.sqlTruthStore.vectorRepairDebtReport().pending;
        const needsRepair = missingVectorRows > 0 || staleVectorRows > 0 || pendingRepairDebt > 0 || this.vectorCompanionError !== null;
        return {
            truthCount,
            checkedTruthRows: truthEntries.length,
            vectorRows: vectorIds.length,
            missingVectorRows,
            staleVectorRows,
            truncated,
            repairHint: needsRepair ? "Run: openclaw clawlore repair-vectors --dry-run" : null,
        };
    }
    async getVectorScopeCounts() {
        await this.ensureInitialized();
        if (this.sqliteVectorStore)
            return this.sqliteVectorStore.scopeCounts();
        if (!this.table)
            return {};
        const rows = await this.table.query().select(["id", "scope"]).toArray();
        const counts = {};
        for (const row of rows) {
            const id = typeof row.id === "string" ? row.id : "";
            if (!id || id === "__schema__")
                continue;
            const scope = typeof row.scope === "string" && row.scope.trim() ? row.scope : "global";
            counts[scope] = (counts[scope] ?? 0) + 1;
        }
        return counts;
    }
    async rebuildVectorCompanion(embedder, options = {}) {
        await this.ensureInitialized();
        if (!this.sqlTruthStore) {
            throw new Error("SQL truth store is unavailable; cannot rebuild vector companion safely");
        }
        const batchSize = clampInt(options.batchSize ?? 32, 1, 128);
        const limit = options.limit === undefined
            ? undefined
            : clampInt(options.limit, 1, 1_000_000);
        const dryRun = options.dryRun === true;
        const fullRebuild = options.fullRebuild === true;
        const truthEntries = this.listSqlTruthEntries(limit);
        const vectorIdsBefore = await this.listVectorIds();
        const vectorIdSet = new Set(vectorIdsBefore);
        const truthIds = new Set(truthEntries.map((entry) => entry.id));
        const repairDebt = this.sqlTruthStore.listVectorRepairDebt(limit ?? 100_000);
        const repairUpsertIds = new Set(repairDebt.filter((entry) => entry.action === "upsert").map((entry) => entry.memoryId));
        const repairDeleteIds = new Set(repairDebt.filter((entry) => entry.action === "delete").map((entry) => entry.memoryId));
        const entries = fullRebuild
            ? truthEntries
            : truthEntries.filter((entry) => !vectorIdSet.has(entry.id) || repairUpsertIds.has(entry.id));
        const staleVectorIds = limit === undefined
            ? [...new Set([
                    ...vectorIdsBefore.filter((id) => !truthIds.has(id)),
                    ...repairDeleteIds,
                ])]
            : [];
        const result = {
            dryRun,
            fullRebuild,
            truthCount: this.sqlTruthStore.count(),
            vectorRowsBefore: vectorIdsBefore.length,
            staleVectorRowsDeleted: dryRun ? staleVectorIds.length : 0,
            processed: 0,
            rebuilt: 0,
            skipped: 0,
            errors: [],
        };
        if (dryRun) {
            result.processed = entries.length;
            result.rebuilt = entries.length;
            return result;
        }
        return this.runWithFileLock(async () => {
            for (const id of staleVectorIds) {
                if (await this.deleteVectorCompanionById(id, "repair-delete-stale-vector")) {
                    result.staleVectorRowsDeleted++;
                }
                else {
                    result.errors.push(`${id}: vector companion delete failed; durable repair debt retained`);
                }
            }
            for (let i = 0; i < entries.length; i += batchSize) {
                const batch = entries.slice(i, i + batchSize);
                const rebuiltEntries = await this.embedRebuildBatch(embedder, batch, result.errors);
                result.processed += batch.length;
                result.skipped += batch.length - rebuiltEntries.length;
                for (const entry of rebuiltEntries) {
                    if (await this.replaceVectorCompanion(entry, "repair-delete-old-vector", "repair-add-vector")) {
                        result.rebuilt++;
                    }
                    else {
                        result.errors.push(`${entry.id}: vector companion upsert failed; durable repair debt retained`);
                    }
                }
            }
            if (result.errors.length > 0 || result.rebuilt !== entries.length) {
                this.vectorCompanionError = `repair-vector-companion incomplete: rebuilt ${result.rebuilt}/${entries.length}, errors=${result.errors.length}`;
            }
            else {
                this.vectorCompanionError = null;
            }
            return result;
        });
    }
    /** Rebuild FTS index (drops and recreates). Useful for recovery after corruption. */
    async rebuildFtsIndex() {
        await this.ensureInitialized();
        if (this.sqliteVectorStore) {
            return { success: true };
        }
        try {
            // Drop existing FTS index if any
            const indices = await this.table.listIndices();
            for (const idx of indices) {
                if (idx.indexType === "FTS" || idx.columns?.includes("text")) {
                    try {
                        await this.table.dropIndex(idx.name || "text");
                    }
                    catch (err) {
                        console.warn(`clawlore: dropIndex(${idx.name || "text"}) failed: ${diagnosticErrorSummary(err)}`);
                    }
                }
            }
            // Recreate
            await this.createFtsIndex(this.table);
            this.ftsIndexCreated = true;
            this._lastFtsError = null;
            return { success: true };
        }
        catch (err) {
            const msg = diagnosticErrorSummary(err);
            this._lastFtsError = msg;
            this.ftsIndexCreated = false;
            return { success: false, error: msg };
        }
    }
    /**
     * Fetch memories older than `maxTimestamp` including their raw vectors.
     * Used exclusively by the memory compactor; vectors are intentionally
     * omitted from `list()` for performance, but compaction needs them for
     * cosine-similarity clustering.
     */
    async fetchForCompaction(maxTimestamp, scopeFilter, limit = 200) {
        await this.ensureInitialized();
        if (this.sqliteVectorStore) {
            return this.sqliteVectorStore
                .listEntriesWithVectors()
                .filter((entry) => entry.timestamp < maxTimestamp)
                .filter((entry) => !scopeFilter || scopeFilter.length === 0 || scopeFilter.includes(entry.scope || "global"))
                .slice(0, limit);
        }
        const conditions = [`timestamp < ${maxTimestamp}`];
        if (scopeFilter && scopeFilter.length > 0) {
            const scopeConditions = scopeFilter
                .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
                .join(" OR ");
            conditions.push(`((${scopeConditions}) OR scope IS NULL)`);
        }
        const whereClause = conditions.join(" AND ");
        const results = await this.table
            .query()
            .where(whereClause)
            .toArray();
        return results
            .slice(0, limit)
            .map((row) => ({
            id: row.id,
            text: row.text,
            vector: Array.isArray(row.vector) ? row.vector : [],
            category: row.category,
            scope: row.scope ?? "global",
            importance: Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: row.metadata || "{}",
        }));
    }
}
