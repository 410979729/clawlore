import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

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
      scope TEXT NOT NULL,
      metadata TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED, text);
  `);
  const insertTruth = db.prepare("INSERT INTO memory_truth(id, text, scope, metadata) VALUES (?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO memory_truth_fts(memory_id, text) VALUES (?, ?)");
  db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < rowCount; index++) {
    const id = `scale-${String(index).padStart(7, "0")}`;
    const scope = `user:${index % 64}`;
    const text = `SCALERECALL${index} tenant ${index % 64} recovery snapshot rollback verification record ${index}`;
    insertTruth.run(id, text, scope, '{"state":"confirmed","memory_layer":"durable"}');
    insertFts.run(id, text);
  }
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

  const metrics = {
    rows: rowCount,
    queries: queryCount,
    buildMs,
    latencyMs: {
      p50: Math.round(percentile(latencies, 0.5) * 1000) / 1000,
      p95: Math.round(percentile(latencies, 0.95) * 1000) / 1000,
      max: Math.round(Math.max(...latencies) * 1000) / 1000,
    },
    knownAnswerRecall: 1,
    crossScopeLeakage: 0,
  };
  assert.ok(metrics.latencyMs.p95 <= maxP95Ms, `p95 ${metrics.latencyMs.p95}ms exceeds ${maxP95Ms}ms`);
  console.log(JSON.stringify({ ok: true, benchmark: "sqlite-fts-scale-v1", metrics }, null, 2));
} finally {
  db.close();
}
