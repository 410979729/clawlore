import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const {
  collectDigestChunks,
  digestRecoveryReport,
  digestReport,
  ensureDigestSchema,
  recoverDigestChunks,
  runDigestPipeline,
} = jiti("../src/digest-pipeline.ts");
const { buildOperatorDashboard } = jiti("../src/operator-dashboard.ts");

function createMemoryTruthDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE memory_truth (
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
    CREATE VIRTUAL TABLE memory_truth_fts USING fts5(
      memory_id UNINDEXED,
      text,
      metadata_text
    );
  `);
  return db;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = ?").get(name));
}

function createStore(db) {
  let id = 0;
  return {
    async store(entry) {
      id += 1;
      const full = {
        ...entry,
        id: `digest-mem-${id}`,
        timestamp: 1_800_000_000_000 + id,
      };
      db.prepare(`
        INSERT INTO memory_truth(id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)
      `).run(
        full.id,
        full.text,
        full.category,
        full.scope,
        full.importance,
        full.timestamp,
        full.metadata,
        full.timestamp,
      );
      db.prepare("INSERT INTO memory_truth_fts(memory_id, text, metadata_text) VALUES (?, ?, '')").run(full.id, full.text);
      return full;
    },
  };
}

test("digest dry-run extracts durable candidates without writing ledger or memory rows", async () => {
  const db = createMemoryTruthDb();
  const result = await runDigestPipeline(db, {
    inputText: "Decision: OpenClaw scope-recall digest must run release gate and verify doctor before live rollout.",
    scope: "agent:main",
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.status, "ok_with_fallback");
  assert.equal(result.extracted, 1);
  assert.equal(result.stored, 0);
  assert.equal(tableExists(db, "openclaw_digest_runs"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_truth").get().count, 0);
});

test("digest reflection collection is scoped before candidate extraction", () => {
  const db = createMemoryTruthDb();
  db.prepare(`
    INSERT INTO memory_truth(id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)
  `).run(
    "reflection-a",
    "Agent A reflection: run release gate before live claims.",
    "reflection",
    "agent:a",
    0.8,
    100,
    "{}",
    100,
  );
  db.prepare(`
    INSERT INTO memory_truth(id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)
  `).run(
    "reflection-b",
    "Agent B reflection: unrelated private workflow.",
    "reflection",
    "agent:b",
    0.8,
    200,
    JSON.stringify({ type: "memory-reflection-event", eventId: "event-b" }),
    200,
  );

  const chunks = collectDigestChunks(db, { scope: "agent:a" });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].source_id, "reflection-a");
  assert.equal(chunks[0].scope, "agent:a");
  assert.doesNotMatch(chunks[0].text, /Agent B/);
});

test("digest apply writes candidate-only memory through store and visible ledger", async () => {
  const db = createMemoryTruthDb();
  const result = await runDigestPipeline(db, {
    apply: true,
    inputText: "Workflow: For scope-recall release, run tests, typecheck, build, golden benchmark, live drift check, then doctor verification.",
    scope: "agent:main",
    store: createStore(db),
    embedPassage: async () => [0.1, 0.2, 0.3],
  });

  assert.equal(result.status, "ok_with_fallback");
  assert.equal(result.stored, 1);
  const row = db.prepare("SELECT * FROM memory_truth WHERE id = ?").get(result.candidates[0].stored_id);
  const metadata = JSON.parse(row.metadata);
  assert.equal(metadata.source, "openclaw-native-digest");
  assert.equal(metadata.lifecycle, "candidate");
  assert.equal(metadata.state, "pending");
  assert.equal(metadata.memory_layer, "digest-candidate");
  assert.equal(metadata.freshness_status, "unknown");

  const report = digestReport(db);
  assert.equal(report.status, "ready");
  assert.equal(report.candidate_debt, 1);
  assert.equal(report.runs.byStatus.ok_with_fallback, 1);

  const dashboard = buildOperatorDashboard(db);
  assert.equal(dashboard.summary.digest_status, "ready");
  assert.equal(dashboard.summary.digest_candidate_debt, 1);
  assert.equal(dashboard.ok, false);
});

test("digest apply filters unsafe chunks and records chunk-scoped skip", async () => {
  const db = createMemoryTruthDb();
  const result = await runDigestPipeline(db, {
    apply: true,
    inputText: "api_key = sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 must never be stored",
    scope: "agent:main",
    store: createStore(db),
    embedPassage: async () => [0.1, 0.2, 0.3],
  });

  assert.equal(result.status, "filtered");
  assert.equal(result.stored, 0);
  const chunk = db.prepare("SELECT status, reason FROM openclaw_digest_chunks").get();
  assert.equal(chunk.status, "filtered");
  assert.match(chunk.reason, /secret/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_truth").get().count, 0);
});

test("digest recovery reports and schedules failed chunks", () => {
  const db = createMemoryTruthDb();
  ensureDigestSchema(db);
  db.prepare(`
    INSERT INTO openclaw_digest_runs (
      id, run_date, started_at, completed_at, status, source_type,
      source_count, chunk_count, candidate_count, stored_count, skipped_count,
      error_count, notes, actor
    ) VALUES ('run-1', '2026-06-30', '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:01.000Z',
      'dead_letter', 'explicit', 1, 1, 0, 0, 0, 1, '{}', 'test')
  `).run();
  db.prepare(`
    INSERT INTO openclaw_digest_chunks (
      id, run_id, source_type, source_id, scope, status, reason,
      preview, candidate_ids, created_at
    ) VALUES ('chunk-1', 'run-1', 'explicit', 'source-1', 'agent:main',
      'dead_letter', 'store_failed', 'preview', '[]', '2026-06-30T00:00:00.000Z')
  `).run();

  const before = digestRecoveryReport(db);
  assert.equal(before.status, "needs_recovery");
  assert.equal(before.candidate_count, 1);

  const scheduled = recoverDigestChunks(db, { dryRun: false });
  assert.equal(scheduled.status, "recovery_scheduled");
  assert.equal(scheduled.recovered, 1);
  assert.equal(db.prepare("SELECT status FROM openclaw_digest_chunks WHERE id = 'chunk-1'").get().status, "pending_recovery");
});
