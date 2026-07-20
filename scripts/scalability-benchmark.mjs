import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  ensureLifecycleProjection,
  openLifecycleProjectionReadAccess,
} = jiti("../src/sql-lifecycle-projection.ts");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

const rowCount = argument("--rows", 200_000);
const queryCount = Math.min(argument("--queries", 64), rowCount);
const maxP95Ms = argument("--max-p95-ms", 250);
const maxLifecycleStatsMs = argument("--max-lifecycle-stats-ms", 500);
const db = new DatabaseSync(":memory:");
const startedAt = performance.now();

try {
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL,
      scope TEXT NOT NULL,
      timestamp REAL NOT NULL,
      metadata TEXT NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED, text);
  `);
  ensureLifecycleProjection(db);
  const insertTruth = db.prepare("INSERT INTO memory_truth(id, text, category, scope, timestamp, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO memory_truth_fts(memory_id, text) VALUES (?, ?)");
  const insertLifecycle = db.prepare(`
    INSERT INTO memory_lifecycle_projection (
      memory_id, scope, static_lifecycle, valid_from, invalidated_at, truth_updated_at,
      projection_fingerprint
    ) VALUES (
      ?, ?, 'dynamic', ?, NULL, ?,
      json_array(?, 'dynamic', CAST(? AS REAL), NULL, CAST(? AS REAL))
    )
  `);
  db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < rowCount; index++) {
    const id = `scale-${String(index).padStart(7, "0")}`;
    const scope = `user:${index % 64}`;
    const text = `SCALERECALL${index} tenant ${index % 64} recovery snapshot rollback verification record ${index}`;
    const timestamp = 1_720_000_000_000 + index;
    insertTruth.run(id, text, "fact", scope, timestamp, '{"state":"confirmed","memory_layer":"durable"}', timestamp);
    insertFts.run(id, text);
    insertLifecycle.run(
      id, scope, timestamp, timestamp,
      scope, timestamp, timestamp,
    );
  }
  db.prepare(`
    UPDATE memory_lifecycle_projection_state
    SET projected_rows = ?, updated_at = ?
    WHERE singleton = 1
  `).run(rowCount, Date.now());
  db.exec("COMMIT");
  const buildMs = Math.round((performance.now() - startedAt) * 1000) / 1000;

  const query = db.prepare(`
    SELECT m.id, m.scope
    FROM memory_truth_fts f
    JOIN memory_truth m ON m.id = f.memory_id
    WHERE memory_truth_fts MATCH ? AND m.scope = ?
    ORDER BY bm25(memory_truth_fts)
    LIMIT 5
  `);
  const latencies = [];
  for (let sample = 0; sample < queryCount; sample++) {
    const index = Math.floor((sample * rowCount) / queryCount);
    const expectedId = `scale-${String(index).padStart(7, "0")}`;
    const expectedScope = `user:${index % 64}`;
    const queryStarted = performance.now();
    const rows = query.all(`"SCALERECALL${index}"`, expectedScope);
    latencies.push(performance.now() - queryStarted);
    assert.equal(rows[0]?.id, expectedId, `known-answer miss at row ${index}`);
    assert.ok(rows.every((row) => row.scope === expectedScope), `cross-scope leakage at row ${index}`);
  }

  const lifecycleStarted = performance.now();
  const lifecycleHealthStarted = performance.now();
  const lifecycleAccess = openLifecycleProjectionReadAccess(db);
  const lifecycleProjection = lifecycleAccess.health;
  const lifecycleHealthMs = Math.round((performance.now() - lifecycleHealthStarted) * 1000) / 1000;
  const lifecycleCountsStarted = performance.now();
  assert.ok(lifecycleAccess.readScopeCounts, "healthy lifecycle projection reader");
  const lifecycle = lifecycleAccess.readScopeCounts({
    scopeSql: "1 = 1",
    scopeParams: [],
    at: 1_800_000_000_000,
  });
  const lifecycleCountsMs = Math.round((performance.now() - lifecycleCountsStarted) * 1000) / 1000;
  const lifecycleStatsMs = Math.round((performance.now() - lifecycleStarted) * 1000) / 1000;
  assert.equal(lifecycleProjection.ok, true, "lifecycle projection revision parity");
  assert.equal(lifecycle.totalCount, rowCount);
  assert.equal(
    Object.values(lifecycle.counts).reduce((sum, counts) => sum + counts.recallable, 0),
    rowCount,
  );
  assert.ok(
    lifecycleStatsMs <= maxLifecycleStatsMs,
    `lifecycle stats ${lifecycleStatsMs}ms exceeds ${maxLifecycleStatsMs}ms`,
  );

  const metrics = {
    rows: rowCount,
    queries: queryCount,
    buildMs,
    latencyMs: {
      p50: Math.round(percentile(latencies, 0.5) * 1000) / 1000,
      p95: Math.round(percentile(latencies, 0.95) * 1000) / 1000,
      max: Math.round(Math.max(...latencies) * 1000) / 1000,
    },
    lifecycleStatsMs,
    lifecycleHealthMs,
    lifecycleCountsMs,
    knownAnswerRecall: 1,
    crossScopeLeakage: 0,
  };
  assert.ok(metrics.latencyMs.p95 <= maxP95Ms, `p95 ${metrics.latencyMs.p95}ms exceeds ${maxP95Ms}ms`);
  console.log(JSON.stringify({ ok: true, benchmark: "sqlite-fts-scale-v1", metrics }, null, 2));
} finally {
  db.close();
}
