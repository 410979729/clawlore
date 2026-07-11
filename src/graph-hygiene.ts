type DatabaseSync = any;

export interface GraphHygieneCounts {
  orphan_entities: number;
  orphan_relations: number;
  orphan_relation_sources: number;
  orphan_relation_targets: number;
  hidden_lifecycle_entities: number;
  hidden_lifecycle_relations: number;
  hidden_lifecycle_relation_sources: number;
  hidden_lifecycle_relation_targets: number;
}

const EMPTY_COUNTS: GraphHygieneCounts = {
  orphan_entities: 0,
  orphan_relations: 0,
  orphan_relation_sources: 0,
  orphan_relation_targets: 0,
  hidden_lifecycle_entities: 0,
  hidden_lifecycle_relations: 0,
  hidden_lifecycle_relation_sources: 0,
  hidden_lifecycle_relation_targets: 0,
};

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => String(row.name)));
}

function countRows(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { count?: number } | undefined;
  return Number(row?.count || 0);
}

function lifecycleVisibleClause(alias: string): string {
  const lifecycle = `LOWER(COALESCE(CASE WHEN json_valid(${alias}.metadata) THEN json_extract(${alias}.metadata, '$.lifecycle') ELSE '' END, ''))`;
  const state = `LOWER(COALESCE(CASE WHEN json_valid(${alias}.metadata) THEN json_extract(${alias}.metadata, '$.state') ELSE '' END, ''))`;
  const layer = `LOWER(COALESCE(CASE WHEN json_valid(${alias}.metadata) THEN json_extract(${alias}.metadata, '$.memory_layer') ELSE '' END, ''))`;
  return `
    ${lifecycle} NOT IN ('archived', 'superseded', 'obsolete', 'rejected')
    AND ${state} NOT IN ('archived', 'rejected')
    AND ${layer} NOT IN ('archive')
  `;
}

function graphSupported(tables: Set<string>): boolean {
  return tables.has("memory_truth") && (tables.has("memory_entities") || tables.has("memory_relations"));
}

export function graphHygieneReport(db: DatabaseSync): Record<string, unknown> {
  const tables = tableNames(db);
  if (!tables.has("memory_truth")) {
    return {
      ok: false,
      status: "unsupported",
      reason: "memory_truth table is missing",
      counts: EMPTY_COUNTS,
    };
  }
  if (!graphSupported(tables)) {
    return {
      ok: true,
      status: "unsupported",
      reason: "OpenClaw graph companion tables are not present",
      counts: EMPTY_COUNTS,
    };
  }

  const counts: GraphHygieneCounts = { ...EMPTY_COUNTS };
  if (tables.has("memory_entities")) {
    counts.orphan_entities = countRows(db, `
      SELECT COUNT(*) AS count
      FROM memory_entities e
      LEFT JOIN memory_truth m ON m.id = e.memory_id
      WHERE m.id IS NULL
    `);
    counts.hidden_lifecycle_entities = countRows(db, `
      SELECT COUNT(*) AS count
      FROM memory_entities e
      JOIN memory_truth m ON m.id = e.memory_id
      WHERE NOT (${lifecycleVisibleClause("m")})
    `);
  }
  if (tables.has("memory_relations")) {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN s.id IS NULL THEN 1 ELSE 0 END) AS orphan_sources,
        SUM(CASE WHEN t.id IS NULL THEN 1 ELSE 0 END) AS orphan_targets,
        SUM(CASE WHEN s.id IS NULL OR t.id IS NULL THEN 1 ELSE 0 END) AS orphan_relations,
        SUM(CASE WHEN s.id IS NOT NULL AND NOT (${lifecycleVisibleClause("s")}) THEN 1 ELSE 0 END) AS hidden_sources,
        SUM(CASE WHEN t.id IS NOT NULL AND NOT (${lifecycleVisibleClause("t")}) THEN 1 ELSE 0 END) AS hidden_targets,
        SUM(CASE WHEN (s.id IS NOT NULL AND NOT (${lifecycleVisibleClause("s")}))
                  OR (t.id IS NOT NULL AND NOT (${lifecycleVisibleClause("t")}))
                 THEN 1 ELSE 0 END) AS hidden_relations
      FROM memory_relations r
      LEFT JOIN memory_truth s ON s.id = r.source_memory_id
      LEFT JOIN memory_truth t ON t.id = r.target_memory_id
    `).get() as Record<string, unknown> | undefined;
    counts.orphan_relation_sources = Number(row?.orphan_sources || 0);
    counts.orphan_relation_targets = Number(row?.orphan_targets || 0);
    counts.orphan_relations = Number(row?.orphan_relations || 0);
    counts.hidden_lifecycle_relation_sources = Number(row?.hidden_sources || 0);
    counts.hidden_lifecycle_relation_targets = Number(row?.hidden_targets || 0);
    counts.hidden_lifecycle_relations = Number(row?.hidden_relations || 0);
  }

  const remaining = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  return {
    ok: remaining === 0,
    status: remaining === 0 ? "ready" : "needs_repair",
    counts,
  };
}

function deleteGraphDebt(db: DatabaseSync, tables: Set<string>): Record<string, number> {
  const deleted = { memory_entities: 0, memory_relations: 0 };
  if (tables.has("memory_entities")) {
    const result = db.prepare(`
      DELETE FROM memory_entities
      WHERE memory_id NOT IN (SELECT id FROM memory_truth)
         OR memory_id IN (SELECT m.id FROM memory_truth m WHERE NOT (${lifecycleVisibleClause("m")}))
    `).run();
    deleted.memory_entities = Number(result?.changes || 0);
  }
  if (tables.has("memory_relations")) {
    const result = db.prepare(`
      DELETE FROM memory_relations
      WHERE source_memory_id NOT IN (SELECT id FROM memory_truth)
         OR target_memory_id NOT IN (SELECT id FROM memory_truth)
         OR source_memory_id IN (SELECT s.id FROM memory_truth s WHERE NOT (${lifecycleVisibleClause("s")}))
         OR target_memory_id IN (SELECT t.id FROM memory_truth t WHERE NOT (${lifecycleVisibleClause("t")}))
    `).run();
    deleted.memory_relations = Number(result?.changes || 0);
  }
  return deleted;
}

export function repairGraphHygiene(
  db: DatabaseSync,
  options: { dryRun?: boolean } = {},
): Record<string, unknown> {
  const dryRun = options.dryRun !== false;
  const tables = tableNames(db);
  const before = graphHygieneReport(db);
  if (before.status === "unsupported") {
    return {
      ...before,
      dry_run: dryRun,
      deleted: { memory_entities: 0, memory_relations: 0 },
      before,
      after: before,
    };
  }

  const deleted = { memory_entities: 0, memory_relations: 0 };
  if (!dryRun) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const applied = deleteGraphDebt(db, tables);
      deleted.memory_entities = applied.memory_entities;
      deleted.memory_relations = applied.memory_relations;
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  }
  const after = graphHygieneReport(db);
  return {
    ok: after.ok,
    status: after.status,
    dry_run: dryRun,
    before,
    deleted,
    after,
  };
}
