import type { MemoryEntry, MemoryTruthStats } from "./memory-store-ports.js";
import {
  parseLifecycleMetadata,
  staticLifecycleForMetadata,
} from "./smart-metadata.js";

type DatabaseSync = any;

const PROJECTION_SCHEMA_VERSION = 4;
const LIFECYCLE_FIELD_FUNCTION = "clawlore_expected_lifecycle_field_v1";
const PROJECTION_COLUMNS = [
  "memory_id",
  "scope",
  "static_lifecycle",
  "valid_from",
  "invalidated_at",
  "truth_updated_at",
  "projection_fingerprint",
] as const;
const PROJECTION_STATE_COLUMNS = [
  "singleton",
  "schema_version",
  "projected_rows",
  "updated_at",
] as const;
const PROJECTION_INDEX_COLUMNS = [
  "scope",
  "static_lifecycle",
  "valid_from",
  "invalidated_at",
] as const;

export type LifecycleProjectionStatus =
  | "ready"
  | "missing"
  | "schema_incompatible"
  | "state_missing"
  | "row_count_mismatch"
  | "row_revision_mismatch"
  | "row_projection_mismatch";

export interface LifecycleProjectionHealth {
  ok: boolean;
  status: LifecycleProjectionStatus;
  reason: string;
  truthRows: number;
  projectedRows: number;
  stateProjectedRows: number | null;
  repairRequired: boolean;
}

function projectionFingerprintExpression(prefix = ""): string {
  return `json_array(
    ${prefix}scope,
    ${prefix}static_lifecycle,
    CAST(${prefix}valid_from AS REAL),
    CASE WHEN ${prefix}invalidated_at IS NULL THEN NULL ELSE CAST(${prefix}invalidated_at AS REAL) END,
    CAST(${prefix}truth_updated_at AS REAL)
  )`;
}

function expectedStaticLifecycleExpression(metadataSql: string, timestampSql: string): string {
  const stateType = `json_type(${metadataSql}, '$.state')`;
  const stateValue = `json_extract(${metadataSql}, '$.state')`;
  const sourceType = `json_type(${metadataSql}, '$.source')`;
  const sourceValue = `json_extract(${metadataSql}, '$.source')`;
  const typeType = `json_type(${metadataSql}, '$.type')`;
  const typeValue = `json_extract(${metadataSql}, '$.type')`;
  const lifecycleType = `json_type(${metadataSql}, '$.lifecycle')`;
  const lifecycleValue = `lower(trim(json_extract(${metadataSql}, '$.lifecycle')))`;
  const lifecycleIsStatic = `COALESCE(
    ${lifecycleType} = 'text'
    AND ${lifecycleValue} IN ('archived', 'obsolete', 'rejected', 'superseded'),
    0
  )`;
  const explicitArchiveLayer = `COALESCE(
    json_type(${metadataSql}, '$.memory_layer') = 'text'
    AND json_extract(${metadataSql}, '$.memory_layer') = 'archive',
    0
  )`;
  return `CASE
    WHEN NOT json_valid(${metadataSql}) THEN 'dynamic'
    WHEN ${lifecycleType} IN ('array', 'object')
      THEN ${LIFECYCLE_FIELD_FUNCTION}(${metadataSql}, ${timestampSql}, 'static_lifecycle')
    WHEN ${stateType} = 'text'
      AND ${stateValue} IN ('pending', 'confirmed')
      AND NOT (${lifecycleIsStatic})
      AND NOT (${explicitArchiveLayer})
      THEN 'dynamic'
    WHEN (${stateType} = 'text' AND ${stateValue} = 'rejected')
      OR (${lifecycleType} = 'text'
        AND ${lifecycleValue} IN ('obsolete', 'rejected', 'superseded'))
      THEN 'inactive'
    WHEN (${stateType} = 'text' AND ${stateValue} = 'archived')
      OR ((${stateType} IS NULL OR ${stateType} = 'null') AND (
        (${sourceType} = 'text' AND ${sourceValue} = 'session-summary')
        OR ((${sourceType} IS NULL OR ${sourceType} = 'null')
          AND ${typeType} = 'text' AND ${typeValue} = 'session-summary')
      ))
      OR (${explicitArchiveLayer})
      OR (${lifecycleType} = 'text' AND ${lifecycleValue} = 'archived')
      THEN 'archived'
    ELSE 'dynamic'
  END`;
}

function expectedTimestampExpression(input: {
  metadataSql: string;
  timestampSql: string;
  field: "valid_from" | "invalidated_at";
}): string {
  const path = `$.${input.field}`;
  const valueType = `json_type(${input.metadataSql}, '${path}')`;
  const value = `json_extract(${input.metadataSql}, '${path}')`;
  const fallback = input.field === "valid_from" ? input.timestampSql : "NULL";
  return `CASE
    WHEN NOT json_valid(${input.metadataSql}) THEN ${fallback}
    WHEN ${valueType} IS NULL OR ${valueType} IN ('null', 'false') THEN ${fallback}
    WHEN ${valueType} IN ('integer', 'real')
      AND CAST(${value} AS REAL) > 0
      AND abs(CAST(${value} AS REAL)) <= 9007199254740991
      THEN floor(CAST(${value} AS REAL))
    WHEN ${valueType} = 'true' THEN 1
    WHEN ${valueType} IN ('integer', 'real', 'text', 'array', 'object')
      THEN ${LIFECYCLE_FIELD_FUNCTION}(
        ${input.metadataSql}, ${input.timestampSql}, '${input.field}'
      )
    ELSE ${fallback}
  END`;
}

const PROJECTION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS memory_lifecycle_projection (
  memory_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  static_lifecycle TEXT NOT NULL CHECK(static_lifecycle IN ('dynamic', 'archived', 'inactive')),
  valid_from REAL NOT NULL,
  invalidated_at REAL,
  truth_updated_at REAL NOT NULL,
  projection_fingerprint TEXT NOT NULL,
  CHECK(projection_fingerprint = ${projectionFingerprintExpression()})
)`;
const PROJECTION_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_projection_scope
  ON memory_lifecycle_projection(scope, static_lifecycle, valid_from, invalidated_at)`;
const PROJECTION_STATE_SQL = `CREATE TABLE IF NOT EXISTS memory_lifecycle_projection_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  schema_version INTEGER NOT NULL,
  projected_rows INTEGER NOT NULL,
  updated_at REAL NOT NULL
)`;

function objectType(db: DatabaseSync, name: string): string {
  const row = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name) as { type?: string } | undefined;
  return String(row?.type || "");
}

function columnsMatch(db: DatabaseSync, table: string, expected: readonly string[]): boolean {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
  return columns.length === expected.length
    && expected.every((column, index) => columns[index] === column);
}

function projectionSchemaCompatible(db: DatabaseSync): boolean {
  if (objectType(db, "memory_lifecycle_projection") !== "table") return false;
  if (objectType(db, "memory_lifecycle_projection_state") !== "table") return false;
  if (objectType(db, "idx_memory_lifecycle_projection_scope") !== "index") return false;
  if (!columnsMatch(db, "memory_lifecycle_projection", PROJECTION_COLUMNS)) return false;
  if (!columnsMatch(db, "memory_lifecycle_projection_state", PROJECTION_STATE_COLUMNS)) return false;
  const indexColumns = (db.prepare("PRAGMA index_info(idx_memory_lifecycle_projection_scope)").all() as Array<{ name: string }>)
    .map((row) => row.name);
  return indexColumns.length === PROJECTION_INDEX_COLUMNS.length
    && PROJECTION_INDEX_COLUMNS.every((column, index) => indexColumns[index] === column);
}

function valuesFor(entry: Pick<MemoryEntry, "id" | "text" | "category" | "scope" | "timestamp" | "metadata">, truthUpdatedAt: number) {
  const metadata = parseLifecycleMetadata(entry.metadata, entry);
  return {
    memoryId: entry.id,
    scope: entry.scope || "global",
    staticLifecycle: staticLifecycleForMetadata(metadata),
    validFrom: metadata.valid_from,
    invalidatedAt: metadata.invalidated_at ?? null,
    truthUpdatedAt,
  };
}

function sqlText(value: unknown): string {
  return value == null ? "" : String(value);
}

function sqlNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function registerLifecycleFieldFunction(db: DatabaseSync): void {
  if (typeof db.function !== "function") {
    throw new Error("CLAWLORE_LIFECYCLE_PROJECTION_HEALTH: SQLite scalar functions unavailable");
  }
  db.function(
    LIFECYCLE_FIELD_FUNCTION,
    { deterministic: true },
    (
      truthMetadata: unknown,
      truthTimestamp: unknown,
      field: unknown,
    ): string | number | null => {
      const normalized = parseLifecycleMetadata(sqlText(truthMetadata), {
        timestamp: sqlNumber(truthTimestamp),
      });
      switch (sqlText(field)) {
        case "static_lifecycle": return staticLifecycleForMetadata(normalized);
        case "valid_from": return normalized.valid_from;
        case "invalidated_at": return normalized.invalidated_at ?? null;
        default: return null;
      }
    },
  );
}

function writeProjection(db: DatabaseSync, values: ReturnType<typeof valuesFor>): void {
  db.prepare(`
    INSERT INTO memory_lifecycle_projection (
      memory_id, scope, static_lifecycle, valid_from, invalidated_at, truth_updated_at,
      projection_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, json_array(
      ?, ?, CAST(? AS REAL),
      CASE WHEN ? IS NULL THEN NULL ELSE CAST(? AS REAL) END,
      CAST(? AS REAL)
    ))
    ON CONFLICT(memory_id) DO UPDATE SET
      scope = excluded.scope,
      static_lifecycle = excluded.static_lifecycle,
      valid_from = excluded.valid_from,
      invalidated_at = excluded.invalidated_at,
      truth_updated_at = excluded.truth_updated_at,
      projection_fingerprint = excluded.projection_fingerprint
  `).run(
    values.memoryId,
    values.scope,
    values.staticLifecycle,
    values.validFrom,
    values.invalidatedAt,
    values.truthUpdatedAt,
    values.scope,
    values.staticLifecycle,
    values.validFrom,
    values.invalidatedAt,
    values.invalidatedAt,
    values.truthUpdatedAt,
  );
}

function rebuildProjection(db: DatabaseSync): void {
  db.exec("DELETE FROM memory_lifecycle_projection");
  let projectedRows = 0;
  const rows = db.prepare(`
    SELECT id, text, category, scope, timestamp, metadata, updated_at
    FROM memory_truth
  `).iterate() as Iterable<MemoryEntry & { updated_at: number }>;
  for (const row of rows) {
    writeProjection(db, valuesFor(row, Number(row.updated_at) || 0));
    projectedRows++;
  }
  db.prepare(`
    INSERT INTO memory_lifecycle_projection_state (singleton, schema_version, projected_rows, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      schema_version = excluded.schema_version,
      projected_rows = excluded.projected_rows,
      updated_at = excluded.updated_at
  `).run(PROJECTION_SCHEMA_VERSION, projectedRows, Date.now());
}

function dropObjectIfPresent(db: DatabaseSync, name: string): void {
  const type = objectType(db, name);
  if (!type) return;
  if (!new Set(["table", "view", "index", "trigger"]).has(type)) {
    throw new Error(`CLAWLORE_LIFECYCLE_PROJECTION_SCHEMA: unsupported auxiliary object type ${type}`);
  }
  db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name}`);
}

export function inspectLifecycleProjection(db: DatabaseSync): LifecycleProjectionHealth {
  const truthRows = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_truth").get()?.count || 0);
  const projectionType = objectType(db, "memory_lifecycle_projection");
  const stateType = objectType(db, "memory_lifecycle_projection_state");
  const indexType = objectType(db, "idx_memory_lifecycle_projection_scope");
  if (!projectionType && !stateType && !indexType) {
    return {
      ok: false, status: "missing", reason: "lifecycle_projection_missing", truthRows,
      projectedRows: 0, stateProjectedRows: null, repairRequired: true,
    };
  }
  if (!projectionSchemaCompatible(db)) {
    return {
      ok: false, status: "schema_incompatible", reason: "lifecycle_projection_schema_incompatible", truthRows,
      projectedRows: 0, stateProjectedRows: null, repairRequired: true,
    };
  }

  const projectedRows = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM memory_lifecycle_projection",
  ).get()?.count || 0);
  const state = db.prepare(`
    SELECT schema_version, projected_rows
    FROM memory_lifecycle_projection_state
    WHERE singleton = 1
  `).get() as { schema_version?: number; projected_rows?: number } | undefined;
  if (!state || Number(state.schema_version) !== PROJECTION_SCHEMA_VERSION) {
    return {
      ok: false, status: "state_missing", reason: "lifecycle_projection_state_missing_or_stale", truthRows,
      projectedRows, stateProjectedRows: state?.projected_rows == null ? null : Number(state.projected_rows),
      repairRequired: true,
    };
  }
  const stateProjectedRows = Number(state.projected_rows);
  if (projectedRows !== truthRows || stateProjectedRows !== truthRows) {
    return {
      ok: false, status: "row_count_mismatch", reason: "lifecycle_projection_row_count_mismatch", truthRows,
      projectedRows, stateProjectedRows, repairRequired: true,
    };
  }
  registerLifecycleFieldFunction(db);
  const expectedStaticLifecycle = expectedStaticLifecycleExpression("truth.metadata", "truth.timestamp");
  const expectedValidFrom = expectedTimestampExpression({
    metadataSql: "truth.metadata",
    timestampSql: "truth.timestamp",
    field: "valid_from",
  });
  const normalizedInvalidatedAt = expectedTimestampExpression({
    metadataSql: "truth.metadata",
    timestampSql: "truth.timestamp",
    field: "invalidated_at",
  });
  const expectedInvalidatedAt = `CASE
    WHEN (${normalizedInvalidatedAt}) >= projection.valid_from
      THEN (${normalizedInvalidatedAt})
    ELSE NULL
  END`;
  const rowMismatch = db.prepare(`
    SELECT
      MAX(CASE
        WHEN projection.memory_id IS NULL
          OR projection.scope != COALESCE(NULLIF(truth.scope, ''), 'global')
          OR projection.truth_updated_at != truth.updated_at
          THEN 2
        WHEN projection.static_lifecycle IS NOT (${expectedStaticLifecycle})
          OR projection.valid_from IS NOT (${expectedValidFrom})
          OR projection.invalidated_at IS NOT (${expectedInvalidatedAt})
          THEN 1
        ELSE 0
      END) AS mismatch_status
    FROM memory_truth AS truth
    LEFT JOIN memory_lifecycle_projection AS projection
      ON projection.memory_id = truth.id
  `).get() as { mismatch_status?: number } | undefined;
  if (Number(rowMismatch?.mismatch_status) === 2) {
    return {
      ok: false, status: "row_revision_mismatch", reason: "lifecycle_projection_row_revision_mismatch", truthRows,
      projectedRows, stateProjectedRows, repairRequired: true,
    };
  }
  if (Number(rowMismatch?.mismatch_status) === 1) {
    return {
      ok: false, status: "row_projection_mismatch", reason: "lifecycle_projection_row_projection_mismatch", truthRows,
      projectedRows, stateProjectedRows, repairRequired: true,
    };
  }
  return {
    ok: true, status: "ready", reason: "lifecycle_projection_ready", truthRows,
    projectedRows, stateProjectedRows, repairRequired: false,
  };
}

export function repairLifecycleProjection(db: DatabaseSync): LifecycleProjectionHealth {
  db.exec("SAVEPOINT clawlore_lifecycle_projection_rebuild");
  try {
    dropObjectIfPresent(db, "idx_memory_lifecycle_projection_scope");
    dropObjectIfPresent(db, "memory_lifecycle_projection_state");
    dropObjectIfPresent(db, "memory_lifecycle_projection");
    db.exec(`${PROJECTION_TABLE_SQL}; ${PROJECTION_INDEX_SQL}; ${PROJECTION_STATE_SQL};`);
    rebuildProjection(db);
    db.exec("RELEASE SAVEPOINT clawlore_lifecycle_projection_rebuild");
  } catch (error) {
    try { db.exec("ROLLBACK TO SAVEPOINT clawlore_lifecycle_projection_rebuild"); } catch {}
    try { db.exec("RELEASE SAVEPOINT clawlore_lifecycle_projection_rebuild"); } catch {}
    throw error;
  }
  const health = inspectLifecycleProjection(db);
  if (!health.ok) {
    throw new Error(`CLAWLORE_LIFECYCLE_PROJECTION_REPAIR_FAILED: ${health.reason}`);
  }
  return health;
}

export function ensureLifecycleProjection(
  db: DatabaseSync,
  options: { force?: boolean } = {},
): LifecycleProjectionHealth {
  const health = inspectLifecycleProjection(db);
  if (options.force === true || !health.ok) return repairLifecycleProjection(db);
  return health;
}

export function upsertLifecycleProjection(
  db: DatabaseSync,
  entry: Pick<MemoryEntry, "id" | "text" | "category" | "scope" | "timestamp" | "metadata">,
  truthUpdatedAt: number,
): void {
  const existed = Boolean(db.prepare(
    "SELECT 1 FROM memory_lifecycle_projection WHERE memory_id = ?",
  ).get(entry.id));
  writeProjection(db, valuesFor(entry, truthUpdatedAt));
  if (!existed) {
    db.prepare(`
      UPDATE memory_lifecycle_projection_state
      SET projected_rows = projected_rows + 1, updated_at = ?
      WHERE singleton = 1
    `).run(Date.now());
  }
}

export function deleteLifecycleProjection(db: DatabaseSync, memoryId: string): void {
  const removed = Number(db.prepare(
    "DELETE FROM memory_lifecycle_projection WHERE memory_id = ?",
  ).run(memoryId)?.changes || 0);
  if (removed > 0) {
    db.prepare(`
      UPDATE memory_lifecycle_projection_state
      SET projected_rows = MAX(0, projected_rows - 1), updated_at = ?
      WHERE singleton = 1
    `).run(Date.now());
  }
}

export function syncLifecycleProjectionFromTruth(db: DatabaseSync, memoryId: string): void {
  const row = db.prepare(`
    SELECT id, text, category, scope, timestamp, metadata, updated_at
    FROM memory_truth
    WHERE id = ?
  `).get(memoryId) as (MemoryEntry & { updated_at: number }) | undefined;
  if (!row) {
    deleteLifecycleProjection(db, memoryId);
    return;
  }
  upsertLifecycleProjection(db, row, Number(row.updated_at) || 0);
}

export interface LifecycleScopeCountQuery {
  scopeSql: string;
  scopeParams: unknown[];
  at?: number;
}

export interface LifecycleProjectionReadAccess {
  health: LifecycleProjectionHealth;
  readScopeCounts: ((query: LifecycleScopeCountQuery) => {
    totalCount: number;
    counts: MemoryTruthStats["lifecycleScopeCounts"];
  }) | null;
}

function readLifecycleScopeCounts(db: DatabaseSync, input: LifecycleScopeCountQuery): {
  totalCount: number;
  counts: MemoryTruthStats["lifecycleScopeCounts"];
} {
  const at = input.at ?? Date.now();
  const rows = db.prepare(`
    WITH classified AS (
      SELECT m.scope,
        CASE
          WHEN m.static_lifecycle = 'archived' THEN 'archived'
          WHEN m.static_lifecycle = 'inactive' THEN 'inactive'
          WHEN m.valid_from <= ? AND (m.invalidated_at IS NULL OR m.invalidated_at > ?)
            THEN 'recallable'
          ELSE 'inactive'
        END AS lifecycle
      FROM memory_lifecycle_projection m
      WHERE ${input.scopeSql}
    )
    SELECT scope, lifecycle, COUNT(*) AS count
    FROM classified
    GROUP BY scope, lifecycle
  `).all(at, at, ...input.scopeParams) as Array<{
    scope: string;
    lifecycle: "recallable" | "archived" | "inactive";
    count: number;
  }>;
  const counts: MemoryTruthStats["lifecycleScopeCounts"] = {};
  let totalCount = 0;
  for (const row of rows) {
    const scope = row.scope || "global";
    const scopeCounts = counts[scope] ??= { recallable: 0, archived: 0, inactive: 0 };
    const count = Number(row.count) || 0;
    scopeCounts[row.lifecycle] += count;
    totalCount += count;
  }
  return { totalCount, counts };
}

/**
 * Open the only supported lifecycle-count read path. The raw projection query
 * is intentionally private: callers receive a reader only after truth-derived
 * health succeeds, so a forged but internally consistent projection cannot be
 * consumed by bypassing the health gate.
 */
export function openLifecycleProjectionReadAccess(db: DatabaseSync): LifecycleProjectionReadAccess {
  const health = inspectLifecycleProjection(db);
  return {
    health,
    readScopeCounts: health.ok
      ? (query) => readLifecycleScopeCounts(db, query)
      : null,
  };
}
