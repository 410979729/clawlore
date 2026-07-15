import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { parseSmartMetadata, isMemoryActiveAt } from "./smart-metadata.js";
import { enforcePrivatePath } from "./file-privacy.js";
const require = createRequire(import.meta.url);
function runSql(db, statement) {
    db["exec"](statement);
}
const SQL_TRUTH_AUTHORITY_TABLE = "clawlore_sql_truth_authority";
const SQL_TRUTH_AUTHORITY_ID = "clawlore-sql-truth";
const SQL_TRUTH_AUTHORITY_SCHEMA_VERSION = 1;
const REQUIRED_TRUTH_COLUMNS = [
    "id",
    "text",
    "category",
    "scope",
    "importance",
    "timestamp",
    "metadata",
    "metadata_text",
    "updated_at",
];
const WORD_RE = /[a-zA-Z0-9]{2,}|[\u4e00-\u9fff]{2,}/g;
const MAX_LIST_LIMIT = 10_000;
function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
function queryTokens(text) {
    const seen = new Set();
    const tokens = [];
    for (const match of (text || "").toLowerCase().matchAll(WORD_RE)) {
        const token = match[0];
        if (seen.has(token))
            continue;
        seen.add(token);
        tokens.push(token);
    }
    return tokens;
}
function buildFtsQuery(tokens) {
    return tokens
        .filter(Boolean)
        .slice(0, 12)
        .map((token) => `"${token.replace(/"/g, " ")}"`)
        .join(" OR ");
}
function metadataSearchText(metadata) {
    if (!metadata)
        return "";
    try {
        const parsed = JSON.parse(metadata);
        return [
            parsed.l0_abstract,
            parsed.l1_overview,
            parsed.l2_content,
            parsed.keywords,
            parsed.entities,
            parsed.tags,
            parsed.category,
            parsed.tier,
        ]
            .flatMap((value) => Array.isArray(value) ? value : [value])
            .filter((value) => typeof value === "string" && value.trim())
            .join("\n");
    }
    catch {
        return metadata;
    }
}
function scoreLexicalHit(query, text, metadataText) {
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery)
        return 0;
    const haystack = `${text}\n${metadataText}`.toLowerCase();
    const queryTokenSet = new Set(queryTokens(query));
    const docTokenSet = new Set(queryTokens(haystack));
    let overlap = 0;
    for (const token of queryTokenSet) {
        if (docTokenSet.has(token))
            overlap++;
    }
    const overlapScore = queryTokenSet.size > 0 ? overlap / queryTokenSet.size : 0;
    const phraseBonus = haystack.includes(normalizedQuery) ? 0.35 : 0;
    return Math.max(0, Math.min(1, overlapScore * 0.68 + phraseBonus));
}
function normalizeBm25(rawScores) {
    if (rawScores.size === 0)
        return new Map();
    const values = [...rawScores.values()].filter(Number.isFinite);
    if (values.length === 0)
        return new Map();
    const best = Math.min(...values);
    const worst = Math.max(...values);
    if (best === worst) {
        return new Map([...rawScores.keys()].map((id) => [id, 1]));
    }
    const span = worst - best;
    return new Map([...rawScores.entries()].map(([id, value]) => [
        id,
        Math.max(0, Math.min(1, (worst - value) / span)),
    ]));
}
function toMemoryEntry(row) {
    return {
        id: row.id,
        text: row.text,
        vector: [],
        category: row.category,
        scope: row.scope || "global",
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadata: row.metadata || "{}",
    };
}
export class SqlTruthStore {
    sqlitePath;
    faultInjector;
    db = null;
    savepointSequence = 0;
    constructor(sqlitePath, faultInjector) {
        this.sqlitePath = sqlitePath;
        this.faultInjector = faultInjector;
    }
    get path() {
        return this.sqlitePath;
    }
    static inspectAuthority(sqlitePath) {
        if (!existsSync(sqlitePath)) {
            return {
                status: "missing",
                schemaVersion: null,
                truthRows: null,
                reason: "sql_truth_file_missing",
            };
        }
        let db = null;
        try {
            const { DatabaseSync } = require("node:sqlite");
            db = new DatabaseSync(sqlitePath, { readOnly: true });
            const tableRows = db.prepare("SELECT name, type FROM sqlite_master WHERE name IN (?, ?, ?)").all(SQL_TRUTH_AUTHORITY_TABLE, "memory_truth", "memory_truth_fts");
            const objects = new Map(tableRows.map((row) => [row.name, row.type]));
            const hasTruth = objects.get("memory_truth") === "table";
            const hasFts = objects.has("memory_truth_fts");
            if (!hasTruth || !hasFts) {
                return {
                    status: "untrusted",
                    schemaVersion: null,
                    truthRows: null,
                    reason: "authority_core_schema_missing",
                };
            }
            const columns = new Set(db.prepare("PRAGMA table_info(memory_truth)").all().map((row) => row.name));
            const missingColumns = REQUIRED_TRUTH_COLUMNS.filter((column) => !columns.has(column));
            if (missingColumns.length > 0) {
                return {
                    status: "untrusted",
                    schemaVersion: null,
                    truthRows: null,
                    reason: "authority_truth_schema_incompatible",
                };
            }
            const truthRows = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_truth").get()?.count || 0);
            if (!objects.has(SQL_TRUTH_AUTHORITY_TABLE)) {
                return {
                    status: truthRows > 0 ? "legacy" : "untrusted",
                    schemaVersion: null,
                    truthRows,
                    reason: truthRows > 0
                        ? "legacy_authority_requires_marker_upgrade"
                        : "authority_marker_missing",
                };
            }
            const marker = db.prepare(`SELECT authority_id, schema_version FROM ${SQL_TRUTH_AUTHORITY_TABLE} WHERE singleton = 1`).get();
            const schemaVersion = Number(marker?.schema_version || 0);
            if (marker?.authority_id !== SQL_TRUTH_AUTHORITY_ID || schemaVersion !== SQL_TRUTH_AUTHORITY_SCHEMA_VERSION) {
                return {
                    status: "untrusted",
                    schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : null,
                    truthRows,
                    reason: "authority_marker_invalid",
                };
            }
            return {
                status: "valid",
                schemaVersion,
                truthRows,
                reason: "authority_marker_valid",
            };
        }
        catch {
            return {
                status: "unreadable",
                schemaVersion: null,
                truthRows: null,
                reason: "authority_readonly_probe_failed",
            };
        }
        finally {
            try {
                db?.close?.();
            }
            catch { }
        }
    }
    open(options = {}) {
        if (this.db)
            return;
        const { DatabaseSync } = require("node:sqlite");
        const inspection = SqlTruthStore.inspectAuthority(this.sqlitePath);
        if (inspection.status === "missing" && options.allowCreate === false) {
            throw new Error("CLAWLORE_SQL_TRUTH_AUTHORITY_REQUIRED: SQL truth authority is missing");
        }
        if (inspection.status === "unreadable") {
            throw new Error("CLAWLORE_SQL_TRUTH_UNAVAILABLE: SQL truth authority cannot be opened read-only");
        }
        if (inspection.status === "untrusted") {
            throw new Error(`CLAWLORE_SQL_TRUTH_AUTHORITY_REQUIRED: ${inspection.reason}`);
        }
        if (inspection.status === "legacy" && options.allowLegacyUpgrade !== true) {
            throw new Error("CLAWLORE_SQL_TRUTH_AUTHORITY_REQUIRED: legacy SQL truth requires an explicit marker upgrade");
        }
        mkdirSync(dirname(this.sqlitePath), { recursive: true });
        this.db = new DatabaseSync(this.sqlitePath);
        this.enforcePrivateFiles();
        runSql(this.db, "PRAGMA busy_timeout = 10000");
        runSql(this.db, "PRAGMA journal_mode = WAL");
        runSql(this.db, "PRAGMA synchronous = NORMAL");
        this.ensureSchema();
        this.enforcePrivateFiles();
    }
    close() {
        try {
            this.db?.close?.();
        }
        finally {
            this.db = null;
        }
    }
    upsert(entry) {
        this.withTransaction(() => this.upsertStatements(entry));
    }
    upsertWithVectorIntent(entry, operation) {
        this.withTransaction(() => {
            this.upsertStatements(entry);
            this.recordVectorRepairDebtStatements({
                memoryId: entry.id,
                action: "upsert",
                operation,
                error: "pending_vector_companion_sync",
            });
        });
    }
    upsertStatements(entry) {
        const db = this.requireDb();
        const metadata = entry.metadata || "{}";
        const metadataText = metadataSearchText(metadata);
        db.prepare(`
      INSERT INTO memory_truth (
        id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        category = excluded.category,
        scope = excluded.scope,
        importance = excluded.importance,
        timestamp = excluded.timestamp,
        metadata = excluded.metadata,
        metadata_text = excluded.metadata_text,
        updated_at = excluded.updated_at
      `).run(entry.id, entry.text || "", entry.category || "other", entry.scope || "global", Number(entry.importance) || 0, Number(entry.timestamp) || Date.now(), metadata, metadataText, Date.now());
        this.injectFault("truth_after_upsert");
        this.replaceFts(entry.id, entry.text || "", metadataText);
    }
    delete(id) {
        this.withTransaction(() => this.deleteStatements(id));
    }
    deleteWithVectorIntent(id, operation) {
        this.withTransaction(() => {
            this.deleteStatements(id);
            this.recordVectorRepairDebtStatements({
                memoryId: id,
                action: "delete",
                operation,
                error: "pending_vector_companion_sync",
            });
        });
    }
    deleteStatements(id) {
        const db = this.requireDb();
        this.injectFault("fts_before_delete");
        db.prepare("DELETE FROM memory_truth_fts WHERE memory_id = ?").run(id);
        db.prepare("DELETE FROM memory_truth WHERE id = ?").run(id);
    }
    /**
     * Persist a temporal revision and invalidate its predecessor in one SQL
     * transaction. SQL truth is authoritative; either both rows commit or
     * neither does.
     */
    supersedeAtomically(oldEntry, newEntry, factKey) {
        const db = this.requireDb();
        this.withTransaction(() => {
            const current = db.prepare("SELECT id, scope FROM memory_truth WHERE id = ? LIMIT 1")
                .get(oldEntry.id);
            if (!current || current.scope !== oldEntry.scope) {
                throw new Error(`Supersede predecessor ${oldEntry.id} no longer exists in scope ${oldEntry.scope}`);
            }
            if (oldEntry.id === newEntry.id) {
                throw new Error("Supersede revision must use a new memory id");
            }
            this.upsertStatements(oldEntry);
            this.upsertStatements(newEntry);
            this.recordVectorRepairDebtStatements({
                memoryId: oldEntry.id,
                action: "upsert",
                operation: "supersede-old",
                error: "pending_vector_companion_sync",
            });
            this.recordVectorRepairDebtStatements({
                memoryId: newEntry.id,
                action: "upsert",
                operation: "supersede-new",
                error: "pending_vector_companion_sync",
            });
            const active = db.prepare(`
        SELECT id
        FROM memory_truth
        WHERE scope = ?
          AND json_extract(metadata, '$.fact_key') = ?
          AND COALESCE(json_extract(metadata, '$.invalidated_at'), 0) = 0
          AND COALESCE(json_extract(metadata, '$.superseded_by'), '') = ''
          AND (
            json_extract(metadata, '$.valid_to') IS NULL
            OR CAST(json_extract(metadata, '$.valid_to') AS REAL) > ?
          )
        `).all(oldEntry.scope, factKey, Date.now());
            if (active.length !== 1 || active[0]?.id !== newEntry.id) {
                throw new Error(`Atomic supersede invariant failed for ${oldEntry.scope}/${factKey}: expected only ${newEntry.id}, found ${active.map((row) => row.id).join(",") || "none"}`);
            }
        });
    }
    getById(id, scopeFilter) {
        const db = this.requireDb();
        const scope = this.scopeClause("memory_truth", scopeFilter);
        const row = db.prepare(`
      SELECT *
      FROM memory_truth
      WHERE id = ? AND ${scope.sql}
      LIMIT 1
      `).get(id, ...scope.params);
        return row ? toMemoryEntry(row) : null;
    }
    getByIds(ids, scopeFilter) {
        const uniqueIds = [...new Set(ids.filter(Boolean))];
        if (uniqueIds.length === 0)
            return [];
        const db = this.requireDb();
        const scope = this.scopeClause("memory_truth", scopeFilter);
        const placeholders = uniqueIds.map(() => "?").join(", ");
        const rows = db.prepare(`
      SELECT *
      FROM memory_truth
      WHERE id IN (${placeholders}) AND ${scope.sql}
      `).all(...uniqueIds, ...scope.params);
        return rows.map(toMemoryEntry);
    }
    recordVectorRepairDebt(input) {
        this.withTransaction(() => this.recordVectorRepairDebtStatements(input));
    }
    recordVectorRepairDebtStatements(input) {
        const now = Date.now();
        this.injectFault("vector_intent_before_insert");
        this.requireDb().prepare(`
      INSERT INTO vector_companion_repair_outbox (
        memory_id, action, operation, last_error, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        action = excluded.action,
        operation = excluded.operation,
        last_error = excluded.last_error,
        attempts = vector_companion_repair_outbox.attempts + 1,
        updated_at = excluded.updated_at
      `).run(input.memoryId, input.action, input.operation, input.error, now, now);
    }
    clearVectorRepairDebt(memoryId) {
        this.withTransaction(() => {
            this.requireDb()
                .prepare("DELETE FROM vector_companion_repair_outbox WHERE memory_id = ?")
                .run(memoryId);
        });
    }
    vectorRepairDebtReport() {
        const row = this.requireDb().prepare(`
      SELECT
        COUNT(*) AS pending,
        MIN(created_at) AS oldest_created_at,
        MAX(updated_at) AS latest_updated_at
      FROM vector_companion_repair_outbox
      `).get();
        return {
            pending: Number(row?.pending || 0),
            oldestCreatedAt: row?.oldest_created_at == null ? null : Number(row.oldest_created_at),
            latestUpdatedAt: row?.latest_updated_at == null ? null : Number(row.latest_updated_at),
        };
    }
    listVectorRepairDebt(limit = 100_000) {
        const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, 1_000_000));
        const rows = this.requireDb().prepare(`
      SELECT memory_id, action, operation, attempts, created_at, updated_at
      FROM vector_companion_repair_outbox
      ORDER BY updated_at ASC, memory_id ASC
      LIMIT ?
      `).all(safeLimit);
        return rows.map((row) => ({
            memoryId: row.memory_id,
            action: row.action,
            operation: row.operation,
            attempts: Number(row.attempts),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        }));
    }
    findByPrefix(prefix, scopeFilter) {
        const db = this.requireDb();
        const scope = this.scopeClause("memory_truth", scopeFilter);
        const rows = db.prepare(`
      SELECT *
      FROM memory_truth
      WHERE id LIKE ? AND ${scope.sql}
      ORDER BY timestamp DESC
      LIMIT 50
      `).all(`${prefix}%`, ...scope.params);
        return rows.map(toMemoryEntry);
    }
    list(scopeFilter, category, limit = 20, offset = 0) {
        const db = this.requireDb();
        const scope = this.scopeClause("m", scopeFilter);
        const clauses = [scope.sql];
        const params = [...scope.params];
        if (category) {
            clauses.push("m.category = ?");
            params.push(category);
        }
        const safeLimit = clampInt(limit, 1, MAX_LIST_LIMIT);
        const safeOffset = clampInt(offset, 0, 1000000);
        const rows = db.prepare(`
      SELECT m.*
      FROM memory_truth m
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
      `).all(...params, safeLimit, safeOffset);
        return rows.map(toMemoryEntry);
    }
    stats(scopeFilter) {
        const db = this.requireDb();
        const scope = this.scopeClause("m", scopeFilter);
        const total = db.prepare(`SELECT COUNT(*) AS count FROM memory_truth m WHERE ${scope.sql}`).get(...scope.params);
        const scopeRows = db.prepare(`
      SELECT COALESCE(m.scope, 'global') AS scope, COUNT(*) AS count
      FROM memory_truth m
      WHERE ${scope.sql}
      GROUP BY COALESCE(m.scope, 'global')
      `).all(...scope.params);
        const categoryRows = db.prepare(`
      SELECT m.category AS category, COUNT(*) AS count
      FROM memory_truth m
      WHERE ${scope.sql}
      GROUP BY m.category
      `).all(...scope.params);
        return {
            totalCount: Number(total?.count || 0),
            scopeCounts: Object.fromEntries(scopeRows.map((row) => [row.scope, Number(row.count)])),
            categoryCounts: Object.fromEntries(categoryRows.map((row) => [row.category, Number(row.count)])),
        };
    }
    bulkDelete(scopeFilter, beforeTimestamp) {
        const db = this.requireDb();
        const clauses = [];
        const params = [];
        if (scopeFilter.length > 0) {
            const scope = this.scopeClause("m", scopeFilter);
            clauses.push(scope.sql);
            params.push(...scope.params);
        }
        if (beforeTimestamp) {
            clauses.push("m.timestamp < ?");
            params.push(beforeTimestamp);
        }
        if (clauses.length === 0) {
            throw new Error("SQL truth bulk delete requires at least scope or timestamp filter");
        }
        const rows = db.prepare(`SELECT m.id FROM memory_truth m WHERE ${clauses.join(" AND ")}`).all(...params);
        this.withTransaction(() => {
            for (const row of rows) {
                this.deleteStatements(row.id);
                this.recordVectorRepairDebtStatements({
                    memoryId: row.id,
                    action: "delete",
                    operation: "bulk-delete",
                    error: "pending_vector_companion_sync",
                });
            }
        });
        return rows.map((row) => row.id);
    }
    reconcile(entries, options = {}) {
        const db = this.requireDb();
        let upserted = 0;
        let deleted = 0;
        const deleteMissing = options.deleteMissing === true;
        return this.withTransaction(() => {
            const wanted = new Set(entries.map((entry) => entry.id).filter(Boolean));
            for (const entry of entries) {
                if (!entry.id)
                    continue;
                this.upsertStatements(entry);
                upserted++;
            }
            if (deleteMissing) {
                const rows = db.prepare("SELECT id FROM memory_truth").all();
                for (const row of rows) {
                    if (wanted.has(row.id))
                        continue;
                    this.deleteStatements(row.id);
                    deleted++;
                }
            }
            return { upserted, deleted };
        });
    }
    search(query, limit, scopeFilter, options) {
        const db = this.requireDb();
        const trimmed = query.trim();
        if (!trimmed)
            return [];
        const safeLimit = clampInt(limit, 1, 20);
        const candidatePool = Math.min(Math.max(safeLimit * 4, safeLimit), 120);
        const tokens = queryTokens(trimmed);
        const ftsQuery = buildFtsQuery(tokens);
        const rowsById = new Map();
        const rawBm25 = new Map();
        const scope = this.scopeClause("m", scopeFilter);
        if (ftsQuery) {
            const rows = db.prepare(`
        SELECT m.*, bm25(memory_truth_fts) AS raw_bm25
        FROM memory_truth_fts
        JOIN memory_truth m ON m.id = memory_truth_fts.memory_id
        WHERE memory_truth_fts MATCH ? AND ${scope.sql}
        ORDER BY bm25(memory_truth_fts) ASC, m.timestamp DESC
        LIMIT ?
        `).all(ftsQuery, ...scope.params, candidatePool);
            for (const row of rows) {
                rowsById.set(row.id, row);
                if (Number.isFinite(Number(row.raw_bm25))) {
                    rawBm25.set(row.id, Number(row.raw_bm25));
                }
            }
        }
        for (const term of tokens.slice(0, 6)) {
            const likeScope = this.scopeClause("m", scopeFilter);
            const rows = db.prepare(`
        SELECT m.*, NULL AS raw_bm25
        FROM memory_truth m
        WHERE (m.text LIKE ? OR m.metadata_text LIKE ?) AND ${likeScope.sql}
        ORDER BY m.timestamp DESC
        LIMIT ?
        `).all(`%${term}%`, `%${term}%`, ...likeScope.params, candidatePool);
            for (const row of rows) {
                if (!rowsById.has(row.id))
                    rowsById.set(row.id, row);
            }
        }
        const bm25Scores = normalizeBm25(rawBm25);
        const results = [];
        for (const row of rowsById.values()) {
            const entry = toMemoryEntry(row);
            if (options?.excludeInactive && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
                continue;
            }
            const lexical = scoreLexicalHit(trimmed, row.text || "", row.metadata_text || "");
            const bm25 = bm25Scores.get(row.id) ?? 0;
            const score = Math.max(lexical, bm25 * 0.96);
            if (score <= 0)
                continue;
            results.push({ entry, score });
        }
        return results
            .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
            .slice(0, safeLimit);
    }
    count() {
        return Number(this.requireDb().prepare("SELECT COUNT(*) AS count FROM memory_truth").get()?.count || 0);
    }
    ensureSchema() {
        const db = this.requireDb();
        runSql(db, `
      CREATE TABLE IF NOT EXISTS memory_truth (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        scope TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0,
        timestamp REAL NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        metadata_text TEXT NOT NULL DEFAULT '',
        updated_at REAL NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_truth_fts USING fts5(
        memory_id UNINDEXED,
        text,
        metadata_text
      );
      CREATE INDEX IF NOT EXISTS idx_memory_truth_scope_timestamp
        ON memory_truth(scope, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_truth_category_timestamp
        ON memory_truth(category, timestamp DESC);
      CREATE TABLE IF NOT EXISTS vector_companion_repair_outbox (
        memory_id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK(action IN ('upsert', 'delete')),
        operation TEXT NOT NULL,
        last_error TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vector_companion_repair_updated_at
        ON vector_companion_repair_outbox(updated_at ASC);
      CREATE TABLE IF NOT EXISTS ${SQL_TRUTH_AUTHORITY_TABLE} (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        authority_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS memory_truth_single_active_fact_insert
      BEFORE INSERT ON memory_truth
      WHEN json_extract(NEW.metadata, '$.fact_key') IS NOT NULL
        AND COALESCE(json_extract(NEW.metadata, '$.invalidated_at'), 0) = 0
        AND COALESCE(json_extract(NEW.metadata, '$.superseded_by'), '') = ''
        AND EXISTS (
          SELECT 1 FROM memory_truth AS current
          WHERE current.scope = NEW.scope
            AND current.id != NEW.id
            AND json_extract(current.metadata, '$.fact_key') = json_extract(NEW.metadata, '$.fact_key')
            AND COALESCE(json_extract(current.metadata, '$.invalidated_at'), 0) = 0
            AND COALESCE(json_extract(current.metadata, '$.superseded_by'), '') = ''
        )
      BEGIN
        SELECT RAISE(ABORT, 'active fact_key uniqueness violation');
      END;
      CREATE TRIGGER IF NOT EXISTS memory_truth_single_active_fact_update
      BEFORE UPDATE OF scope, metadata ON memory_truth
      WHEN json_extract(NEW.metadata, '$.fact_key') IS NOT NULL
        AND COALESCE(json_extract(NEW.metadata, '$.invalidated_at'), 0) = 0
        AND COALESCE(json_extract(NEW.metadata, '$.superseded_by'), '') = ''
        AND EXISTS (
          SELECT 1 FROM memory_truth AS current
          WHERE current.scope = NEW.scope
            AND current.id != NEW.id
            AND json_extract(current.metadata, '$.fact_key') = json_extract(NEW.metadata, '$.fact_key')
            AND COALESCE(json_extract(current.metadata, '$.invalidated_at'), 0) = 0
            AND COALESCE(json_extract(current.metadata, '$.superseded_by'), '') = ''
        )
      BEGIN
        SELECT RAISE(ABORT, 'active fact_key uniqueness violation');
      END;
      `);
        const now = Date.now();
        db.prepare(`
      INSERT INTO ${SQL_TRUTH_AUTHORITY_TABLE} (
        singleton, authority_id, schema_version, created_at, updated_at
      ) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        authority_id = excluded.authority_id,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at
      `).run(SQL_TRUTH_AUTHORITY_ID, SQL_TRUTH_AUTHORITY_SCHEMA_VERSION, now, now);
        this.reconcileFts();
    }
    ftsIntegrityReport() {
        const db = this.requireDb();
        const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_truth) AS truth_rows,
        (SELECT COUNT(*) FROM memory_truth_fts) AS fts_rows,
        (
          SELECT COUNT(*)
          FROM memory_truth_fts AS f
          LEFT JOIN memory_truth AS m ON m.id = f.memory_id
          WHERE m.id IS NULL
        ) AS stale_fts_rows,
        (
          SELECT COUNT(*)
          FROM memory_truth AS m
          LEFT JOIN memory_truth_fts AS f ON f.memory_id = m.id
          WHERE f.memory_id IS NULL
        ) AS missing_fts_rows,
        (
          SELECT COALESCE(SUM(extra), 0)
          FROM (
            SELECT COUNT(*) - 1 AS extra
            FROM memory_truth_fts
            GROUP BY memory_id
            HAVING COUNT(*) > 1
          )
        ) AS duplicate_fts_extra_rows
      `).get();
        const report = {
            truthRows: Number(counts.truth_rows || 0),
            ftsRows: Number(counts.fts_rows || 0),
            staleFtsRows: Number(counts.stale_fts_rows || 0),
            missingFtsRows: Number(counts.missing_fts_rows || 0),
            duplicateFtsExtraRows: Number(counts.duplicate_fts_extra_rows || 0),
            healthy: false,
        };
        report.healthy =
            report.truthRows === report.ftsRows &&
                report.staleFtsRows === 0 &&
                report.missingFtsRows === 0 &&
                report.duplicateFtsExtraRows === 0;
        return report;
    }
    reconcileFts() {
        const db = this.requireDb();
        if (this.ftsIntegrityReport().healthy)
            return;
        runSql(db, "DELETE FROM memory_truth_fts");
        runSql(db, "INSERT INTO memory_truth_fts(memory_id, text, metadata_text) SELECT id, text, metadata_text FROM memory_truth");
    }
    replaceFts(id, text, metadataText) {
        const db = this.requireDb();
        db.prepare("DELETE FROM memory_truth_fts WHERE memory_id = ?").run(id);
        this.injectFault("fts_before_insert");
        db.prepare("INSERT INTO memory_truth_fts(memory_id, text, metadata_text) VALUES (?, ?, ?)").run(id, text, metadataText);
    }
    injectFault(point) {
        this.faultInjector?.(point);
    }
    withTransaction(operation) {
        const db = this.requireDb();
        const savepoint = `clawlore_truth_${++this.savepointSequence}`;
        runSql(db, `SAVEPOINT ${savepoint}`);
        try {
            const result = operation();
            // File privacy is part of the durable write contract. Validate it before
            // releasing the savepoint so an enforcement failure rolls SQL/FTS/outbox
            // state back instead of reporting a false API failure after commit.
            this.enforcePrivateFiles();
            runSql(db, `RELEASE SAVEPOINT ${savepoint}`);
            return result;
        }
        catch (err) {
            try {
                runSql(db, `ROLLBACK TO SAVEPOINT ${savepoint}`);
            }
            catch { }
            try {
                runSql(db, `RELEASE SAVEPOINT ${savepoint}`);
            }
            catch { }
            throw err;
        }
    }
    enforcePrivateFiles() {
        this.injectFault("permissions_before_enforce");
        for (const path of [this.sqlitePath, `${this.sqlitePath}-wal`, `${this.sqlitePath}-shm`]) {
            try {
                if (!existsSync(path))
                    continue;
                enforcePrivatePath(path, { kind: "file" });
            }
            catch (err) {
                const name = path === this.sqlitePath
                    ? "database"
                    : path.endsWith("-wal")
                        ? "wal"
                        : "shm";
                throw new Error(`CLAWLORE_SQL_TRUTH_PERMISSION_ENFORCEMENT_FAILED: ${name} is not private`, { cause: err });
            }
        }
    }
    scopeClause(alias, scopeFilter) {
        if (scopeFilter === undefined) {
            return { sql: "1 = 1", params: [] };
        }
        if (scopeFilter.length === 0)
            return { sql: "0 = 1", params: [] };
        const scopes = scopeFilter.filter(Boolean);
        if (scopes.length === 0) {
            return { sql: "0 = 1", params: [] };
        }
        const placeholders = scopes.map(() => "?").join(", ");
        return {
            sql: `(${alias}.scope IN (${placeholders}) OR ${alias}.scope IS NULL)`,
            params: scopes,
        };
    }
    /**
     * Get the underlying database connection for Experience Kernel operations.
     * @internal
     */
    getDb() {
        return this.requireDb();
    }
    requireDb() {
        if (!this.db) {
            throw new Error(`SQL truth store is not open: ${join(this.sqlitePath)}`);
        }
        return this.db;
    }
}
