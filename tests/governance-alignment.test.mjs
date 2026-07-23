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
  activeDirtyCounts,
  applyCleanup,
  ensureGovernanceAuditSchema,
  findCleanupCandidates,
  rollbackCleanupBatch,
} = jiti("../src/governance-cleanup.ts");
const {
  candidateDebtReport,
  promoteMemoryCandidates,
} = jiti("../src/candidate-promotion.ts");
const {
  graphHygieneReport,
  repairGraphHygiene,
} = jiti("../src/graph-hygiene.ts");
const { recoveryReport, scheduleReplay } = jiti("../src/journal-recovery.ts");
const { buildOperatorDashboard } = jiti("../src/operator-dashboard.ts");
const { runForgetting, runForgettingWithVectorSync } = jiti("../src/forgetting.ts");
const {
  ensureLifecycleProjection,
  inspectLifecycleProjection,
  openLifecycleProjectionReadAccess,
} = jiti("../src/sql-lifecycle-projection.ts");

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

function insertMemory(db, id, text, metadata = {}) {
  db.prepare(`
    INSERT INTO memory_truth(id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at)
    VALUES (?, ?, 'other', 'agent:main', 0.7, 1, ?, '', 1)
  `).run(id, text, JSON.stringify(metadata));
  db.prepare("INSERT INTO memory_truth_fts(memory_id, text, metadata_text) VALUES (?, ?, '')").run(id, text);
}

function insertMemoryWith(db, row) {
  db.prepare(`
    INSERT INTO memory_truth(id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)
  `).run(
    row.id,
    row.text,
    row.category || "fact",
    row.scope || "agent:main",
    row.importance ?? 0.7,
    row.timestamp ?? 1,
    JSON.stringify(row.metadata || {}),
    row.updated_at ?? 1,
  );
  db.prepare("INSERT INTO memory_truth_fts(memory_id, text, metadata_text) VALUES (?, ?, '')").run(row.id, row.text);
}

function lifecycleCounts(db) {
  const access = openLifecycleProjectionReadAccess(db);
  assert.ok(access.readScopeCounts, access.health.reason);
  return access.readScopeCounts({ scopeSql: "1=1", scopeParams: [] }).counts["agent:main"];
}

test("governance cleanup dry-run, apply, and rollback handle template noise", () => {
  const db = createMemoryTruthDb();
  insertMemory(db, "ops", "Operations workflow summary from journal digest: user: 继续 assistant: 完成。");
  insertMemory(db, "journal", "Journal digest memory decision/workflow about release.");
  insertMemory(db, "keep", "Joy prefers concise Chinese operation reports.");

  const before = db.prepare("SELECT COUNT(*) AS count FROM memory_truth").get().count;
  const candidates = findCleanupCandidates(db, { scopeFilter: ["agent:main"], limit: 10 });
  const counts = activeDirtyCounts(db, { scopeFilter: ["agent:main"] });
  const dry = applyCleanup(db, { scopeFilter: ["agent:main"], dryRun: true, batchId: "dry-batch" });

  assert.equal(before, 3);
  assert.deepEqual(candidates.map((item) => item.id).sort(), ["journal", "ops"]);
  assert.equal(counts["template.operations-workflow-summary"], 1);
  assert.equal(counts["template.journal-digest-memory"], 1);
  assert.equal(dry.archived, 0);

  const applied = applyCleanup(db, { scopeFilter: ["agent:main"], dryRun: false, batchId: "apply-batch" });
  assert.equal(applied.archived, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM governance_audit_events WHERE batch_id = 'apply-batch'").get().count, 2);
  const archived = JSON.parse(db.prepare("SELECT metadata FROM memory_truth WHERE id = 'ops'").get().metadata);
  assert.equal(archived.lifecycle, "archived");
  assert.equal(archived.rollback_batch_id, "apply-batch");
  assert.equal(inspectLifecycleProjection(db).ok, true);
  assert.deepEqual(lifecycleCounts(db), { recallable: 1, archived: 2, inactive: 0 });

  const rollbackDry = rollbackCleanupBatch(db, { batchId: "apply-batch", dryRun: true });
  assert.equal(rollbackDry.rollback_candidates, 2);
  assert.equal(JSON.parse(db.prepare("SELECT metadata FROM memory_truth WHERE id = 'ops'").get().metadata).lifecycle, "archived");

  const rollback = rollbackCleanupBatch(db, { batchId: "apply-batch", dryRun: false });
  assert.equal(rollback.restored, 2);
  assert.equal(JSON.parse(db.prepare("SELECT metadata FROM memory_truth WHERE id = 'ops'").get().metadata).lifecycle, undefined);
  assert.equal(inspectLifecycleProjection(db).ok, true);
  assert.deepEqual(lifecycleCounts(db), { recallable: 3, archived: 0, inactive: 0 });
});

test("hard delete forgetting fails closed without vector companion callback", async () => {
  const db = createMemoryTruthDb();
  insertMemory(db, "secret-row", "api_key = sk-not-a-real-secret-value-1234567890");

  const result = await runForgettingWithVectorSync(db, {
    scopeFilter: ["agent:main"],
    dryRun: false,
    hardDeleteSensitive: true,
  });

  assert.equal(result.hard_delete_blocked, true);
  assert.equal(result.deleted, 0);
  assert.deepEqual(result.delete_ids, ["secret-row"]);
  assert.ok(db.prepare("SELECT id FROM memory_truth WHERE id = 'secret-row'").get());
});

test("forgetting archives duplicates and deletes sensitive rows with lifecycle parity", () => {
  const db = createMemoryTruthDb();
  insertMemory(db, "duplicate-a", "same durable memory");
  insertMemory(db, "duplicate-b", "same durable memory");
  insertMemory(db, "sensitive", "password=RealSecret123");

  const result = runForgetting(db, {
    scopeFilter: ["agent:main"],
    dryRun: false,
    hardDeleteSensitive: true,
  });

  assert.equal(result.archived, 1);
  assert.equal(result.deleted, 1);
  assert.equal(inspectLifecycleProjection(db).ok, true);
  assert.deepEqual(lifecycleCounts(db), { recallable: 1, archived: 1, inactive: 0 });
  assert.equal(db.prepare("SELECT 1 FROM memory_truth WHERE id='sensitive'").get(), undefined);
});

function createJournalDb() {
  const db = createMemoryTruthDb();
  ensureGovernanceAuditSchema(db);
  db.exec(`
    CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY,
      scope_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      processed_run_id TEXT NOT NULL DEFAULT '',
      processed_at TEXT
    );
    CREATE TABLE journal_rejections (
      journal_entry_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      candidate TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (journal_entry_id, run_id)
    );
    CREATE TABLE memory_journal_sources (
      memory_id TEXT NOT NULL,
      journal_entry_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

test("journal recovery reports unsupported without journal tables and schedules replay when present", () => {
  const unsupported = recoveryReport(createMemoryTruthDb());
  assert.equal(unsupported.status, "unsupported");
  assert.ok(unsupported.missing_tables.includes("journal_entries"));

  const db = createJournalDb();
  db.prepare(`
    INSERT INTO journal_entries(id, scope_id, session_id, turn_number, role, created_at, processed_run_id, processed_at)
    VALUES (1, 'agent:main', 'session-1', 1, 'user', '2026-01-01T00:00:00Z', 'run-failed', '2026-01-01T00:00:01Z')
  `).run();
  db.prepare("INSERT INTO journal_rejections(journal_entry_id, run_id, reason, candidate, created_at) VALUES (1, 'run-failed', 'retry-exhausted:timeout', '', '2026-01-01T00:00:02Z')").run();

  const report = recoveryReport(db, { reasonPrefixes: ["retry-exhausted:"], limit: 10 });
  assert.equal(report.status, "ready");
  assert.equal(report.candidate_count, 1);

  const applied = scheduleReplay(db, { reasonPrefixes: ["retry-exhausted:"], dryRun: false, batchId: "replay-batch" });
  assert.equal(applied.scheduled, 1);
  const row = db.prepare("SELECT processed_run_id, processed_at FROM journal_entries WHERE id = 1").get();
  assert.equal(row.processed_run_id, "");
  assert.equal(row.processed_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM governance_audit_events WHERE batch_id = 'replay-batch'").get().count, 1);
});

test("candidate memory promotion is dry-run first and audits applied safe promotions", () => {
  const db = createMemoryTruthDb();
  insertMemoryWith(db, {
    id: "safe-candidate",
    text: "Joy prefers direct status reports after OpenClaw maintenance tasks.",
    importance: 0.8,
    metadata: {
      lifecycle: "candidate",
      state: "pending",
      memory_category: "preferences",
      confidence: 0.9,
      source: "auto-capture",
    },
  });
  insertMemoryWith(db, {
    id: "risky-candidate",
    text: "Production token rotation requires human review.",
    importance: 0.9,
    metadata: {
      lifecycle: "candidate",
      memory_category: "procedure",
      confidence: 0.95,
      source: "auto-capture",
    },
  });

  const report = candidateDebtReport(db);
  assert.equal(report.status, "debt");
  assert.equal(report.candidate_count, 2);
  assert.equal(report.by_action.promote, 1);
  assert.equal(report.by_action.keep_candidate, 1);

  const dry = promoteMemoryCandidates(db, { dryRun: true, batchId: "dry-candidate-batch" });
  assert.equal(dry.mutations.promoted, 1);
  assert.equal(JSON.parse(db.prepare("SELECT metadata FROM memory_truth WHERE id='safe-candidate'").get().metadata).lifecycle, "candidate");

  const applied = promoteMemoryCandidates(db, { dryRun: false, batchId: "apply-candidate-batch" });
  assert.equal(applied.mutations.promoted, 1);
  const promoted = JSON.parse(db.prepare("SELECT metadata FROM memory_truth WHERE id='safe-candidate'").get().metadata);
  const kept = JSON.parse(db.prepare("SELECT metadata FROM memory_truth WHERE id='risky-candidate'").get().metadata);
  assert.equal(promoted.lifecycle, "promoted");
  assert.equal(promoted.state, "confirmed");
  assert.equal(kept.lifecycle, "candidate");
  assert.equal(inspectLifecycleProjection(db).ok, true);
  assert.deepEqual(lifecycleCounts(db), { recallable: 2, archived: 0, inactive: 0 });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM governance_audit_events WHERE batch_id='apply-candidate-batch' AND event_type='memory_candidate_promotion'").get().count,
    1,
  );
});

test("candidate promotion and lifecycle projection roll back together on projection failure", () => {
  const db = createMemoryTruthDb();
  insertMemoryWith(db, {
    id: "fault-candidate",
    text: "Joy prefers direct verified progress reports.",
    category: "preference",
    metadata: {
      lifecycle: "candidate",
      state: "pending",
      memory_category: "preferences",
      confidence: 0.9,
    },
  });
  promoteMemoryCandidates(db, { dryRun: true });
  // The apply path initializes the projection before opening its mutation transaction.
  ensureLifecycleProjection(db);
  db.exec(`
    CREATE TRIGGER fail_lifecycle_projection_update
    BEFORE UPDATE ON memory_lifecycle_projection
    BEGIN
      SELECT RAISE(ABORT, 'fixture lifecycle projection failure');
    END;
  `);

  assert.throws(
    () => promoteMemoryCandidates(db, { dryRun: false, batchId: "fault-batch" }),
    /fixture lifecycle projection failure/,
  );
  const metadata = JSON.parse(db.prepare(
    "SELECT metadata FROM memory_truth WHERE id='fault-candidate'",
  ).get().metadata);
  assert.equal(metadata.lifecycle, "candidate");
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM governance_audit_events WHERE batch_id='fault-batch'",
  ).get().count, 0);
});

test("graph hygiene reports unsupported without graph tables and removes orphan companion rows when present", () => {
  const unsupported = graphHygieneReport(createMemoryTruthDb());
  assert.equal(unsupported.status, "unsupported");

  const db = createMemoryTruthDb();
  db.exec(`
    CREATE TABLE memory_entities (
      memory_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE memory_relations (
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
  `);
  insertMemoryWith(db, {
    id: "active-memory",
    text: "Project Atlas active fact.",
    metadata: { lifecycle: "promoted" },
  });
  insertMemoryWith(db, {
    id: "archived-memory",
    text: "Project Atlas archived fact.",
    metadata: { lifecycle: "archived", state: "archived", memory_layer: "archive" },
  });
  db.prepare("INSERT INTO memory_entities(memory_id, entity, weight, source) VALUES ('missing-memory', 'ghost', 1, 'fixture')").run();
  db.prepare("INSERT INTO memory_entities(memory_id, entity, weight, source) VALUES ('archived-memory', 'hidden', 1, 'fixture')").run();
  db.prepare("INSERT INTO memory_relations(source_memory_id, target_memory_id, relation_type, confidence, note, created_at) VALUES ('missing-memory', 'active-memory', 'related', 1, '', '')").run();
  db.prepare("INSERT INTO memory_relations(source_memory_id, target_memory_id, relation_type, confidence, note, created_at) VALUES ('active-memory', 'archived-memory', 'related', 1, '', '')").run();

  const report = graphHygieneReport(db);
  assert.equal(report.status, "needs_repair");
  assert.equal(report.counts.orphan_entities, 1);
  assert.equal(report.counts.hidden_lifecycle_entities, 1);
  assert.equal(report.counts.orphan_relations, 1);
  assert.equal(report.counts.hidden_lifecycle_relations, 1);

  const dry = repairGraphHygiene(db, { dryRun: true });
  assert.equal(dry.deleted.memory_entities, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_entities").get().count, 2);

  const applied = repairGraphHygiene(db, { dryRun: false });
  assert.equal(applied.deleted.memory_entities, 2);
  assert.equal(applied.deleted.memory_relations, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_entities").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_relations").get().count, 0);
});

test("graph hygiene apply rolls back when relation cleanup fails", () => {
  const db = createMemoryTruthDb();
  db.exec(`
    CREATE TABLE memory_entities (
      memory_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE memory_relations (
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
  `);
  insertMemoryWith(db, {
    id: "active-memory",
    text: "Project Atlas active fact.",
    metadata: { lifecycle: "promoted" },
  });
  db.prepare("INSERT INTO memory_entities(memory_id, entity, weight, source) VALUES ('missing-memory', 'ghost', 1, 'fixture')").run();
  db.prepare("INSERT INTO memory_relations(source_memory_id, target_memory_id, relation_type, confidence, note, created_at) VALUES ('missing-memory', 'active-memory', 'related', 1, '', '')").run();
  db.exec(`
    CREATE TRIGGER fail_relation_delete
    BEFORE DELETE ON memory_relations
    BEGIN
      SELECT RAISE(ABORT, 'fixture relation delete failure');
    END;
  `);

  assert.throws(
    () => repairGraphHygiene(db, { dryRun: false }),
    /fixture relation delete failure/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_entities").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_relations").get().count, 1);
});

test("operator dashboard summarizes cleanup, journal, fts, and experience status", () => {
  const db = createMemoryTruthDb();
  insertMemory(db, "ops", "Operations workflow summary from journal digest: user: 继续 assistant: 完成。");
  insertMemoryWith(db, {
    id: "candidate",
    text: "Joy prefers direct status reports after maintenance.",
    category: "preference",
    metadata: { lifecycle: "candidate", memory_category: "preferences", confidence: 0.9 },
  });
  insertMemoryWith(db, {
    id: "stale-fact",
    text: "Home gateway current IP was 192.0.2.25.",
    category: "fact",
    metadata: { state: "confirmed", memory_layer: "durable", valid_until: 1 },
  });

  const dashboard = buildOperatorDashboard(db, { version: "test" });

  assert.equal(dashboard.version, "test");
  assert.equal(dashboard.summary.memory_rows, 3);
  assert.equal(dashboard.summary.governance_cleanup_candidates, 1);
  assert.equal(dashboard.summary.memory_candidate_debt, 1);
  assert.equal(dashboard.summary.graph_hygiene_status, "unsupported");
  assert.equal(dashboard.summary.freshness_status, "needs_review");
  assert.equal(dashboard.summary.freshness_debt, 1);
  assert.equal(dashboard.sections.freshness.stale_facts, 1);
  assert.equal(dashboard.summary.journal_recovery_status, "unsupported");
  assert.equal(dashboard.sections.fts.status, "ok");
  assert.equal(dashboard.ok, false);
});
