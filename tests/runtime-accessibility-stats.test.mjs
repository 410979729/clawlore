import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SqlTruthStore } = jiti("../src/sql-truth-store.ts");
const {
  ensureLifecycleProjection,
  inspectLifecycleProjection,
  openLifecycleProjectionReadAccess,
  repairLifecycleProjection,
} = jiti("../src/sql-lifecycle-projection.ts");

function entry(id, metadata) {
  return {
    id,
    text: `lifecycle ${id}`,
    vector: [1, 0],
    category: "fact",
    scope: "agent:main",
    importance: 0.8,
    timestamp: Date.now() - 1_000,
    metadata: JSON.stringify(metadata),
  };
}

test("SQL truth stats distinguish recallable, archived, and other inactive rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-accessibility-stats-"));
  const truth = new SqlTruthStore(join(dir, "memory.sqlite3"));
  try {
    truth.open();
    truth.upsertWithVectorIntent(entry("confirmed", { state: "confirmed" }), "seed");
    truth.upsertWithVectorIntent(entry("archived", { state: "archived" }), "seed");
    truth.upsertWithVectorIntent(entry("rejected", { state: "rejected" }), "seed");
    truth.upsertWithVectorIntent(entry("future", {
      state: "confirmed",
      valid_from: Date.now() + 60_000,
    }), "seed");

    const stats = truth.stats();
    assert.equal(stats.scopeCounts["agent:main"], 4);
    assert.deepEqual(stats.lifecycleScopeCounts["agent:main"], {
      recallable: 1,
      archived: 1,
      inactive: 2,
    });

    truth.upsertWithVectorIntent(entry("confirmed", { state: "archived" }), "archive");
    const updated = truth.stats();
    assert.deepEqual(updated.lifecycleScopeCounts["agent:main"], {
      recallable: 0,
      archived: 2,
      inactive: 2,
    });
    truth.delete("future");
    const deleted = truth.stats();
    assert.deepEqual(deleted.lifecycleScopeCounts["agent:main"], {
      recallable: 0,
      archived: 2,
      inactive: 1,
    });
  } finally {
    truth.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("truth-derived health matches the canonical lifecycle normalization matrix", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-lifecycle-policy-parity-"));
  const truth = new SqlTruthStore(join(dir, "memory.sqlite3"));
  const timestamp = 1_720_000_000_000;
  const cases = [
    { id: "confirmed", metadata: { state: "confirmed" }, lifecycle: "dynamic", validFrom: timestamp, invalidatedAt: null },
    { id: "archived", metadata: { state: "archived" }, lifecycle: "archived", validFrom: timestamp, invalidatedAt: null },
    { id: "rejected", metadata: { state: "rejected" }, lifecycle: "inactive", validFrom: timestamp, invalidatedAt: null },
    { id: "summary-default", metadata: { type: "session-summary" }, lifecycle: "archived", validFrom: timestamp, invalidatedAt: null },
    { id: "invalid-source", metadata: { source: "bogus", type: "session-summary" }, lifecycle: "dynamic", validFrom: timestamp, invalidatedAt: null },
    { id: "invalid-state", metadata: { state: "bogus", source: "session-summary" }, lifecycle: "dynamic", validFrom: timestamp, invalidatedAt: null },
    { id: "archive-layer", metadata: { memory_layer: "archive" }, lifecycle: "archived", validFrom: timestamp, invalidatedAt: null },
    { id: "lifecycle-array", metadata: { lifecycle: ["archived"] }, lifecycle: "archived", validFrom: timestamp, invalidatedAt: null },
    { id: "lifecycle-trim", metadata: { lifecycle: " Obsolete " }, lifecycle: "inactive", validFrom: timestamp, invalidatedAt: null },
    { id: "numeric-string", metadata: { valid_from: "1234", invalidated_at: "2345" }, lifecycle: "dynamic", validFrom: 1234, invalidatedAt: 2345 },
    { id: "numeric-array", metadata: { valid_from: [3456] }, lifecycle: "dynamic", validFrom: 3456, invalidatedAt: null },
    { id: "invalidated-before-valid", metadata: { valid_from: 4000, invalidated_at: 3999 }, lifecycle: "dynamic", validFrom: 4000, invalidatedAt: null },
    { id: "boolean-time", metadata: { valid_from: true, invalidated_at: true }, lifecycle: "dynamic", validFrom: 1, invalidatedAt: 1 },
  ];
  try {
    truth.open();
    for (const item of cases) {
      const candidate = entry(item.id, item.metadata ?? {});
      candidate.timestamp = timestamp;
      candidate.metadata = JSON.stringify(item.metadata);
      truth.upsertWithVectorIntent(candidate, "seed");
    }

    assert.equal(inspectLifecycleProjection(truth.getDb()).status, "ready");
    const rows = truth.getDb().prepare(`
      SELECT memory_id, static_lifecycle, valid_from, invalidated_at
      FROM memory_lifecycle_projection
    `).all();
    const byId = new Map(rows.map((row) => [row.memory_id, row]));
    for (const item of cases) {
      const projected = byId.get(item.id);
      assert.equal(projected.static_lifecycle, item.lifecycle, item.id);
      assert.equal(projected.valid_from, item.validFrom, item.id);
      assert.equal(projected.invalidated_at, item.invalidatedAt, item.id);
    }
  } finally {
    truth.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle auxiliary schema is recovered as one versioned unit", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-lifecycle-schema-"));
  const truth = new SqlTruthStore(join(dir, "memory.sqlite3"));
  try {
    truth.open();
    truth.upsertWithVectorIntent(entry("schema-row", { state: "confirmed" }), "seed");
    const db = truth.getDb();
    db.exec(`
      DROP INDEX idx_memory_lifecycle_projection_scope;
      DROP TABLE memory_lifecycle_projection_state;
      CREATE TABLE memory_lifecycle_projection_state (
        singleton INTEGER PRIMARY KEY,
        projected_rows INTEGER NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TABLE idx_memory_lifecycle_projection_scope (broken TEXT);
    `);

    assert.equal(inspectLifecycleProjection(db).status, "schema_incompatible");
    const repaired = ensureLifecycleProjection(db);
    assert.equal(repaired.ok, true);
    assert.equal(repaired.status, "ready");
    assert.deepEqual(
      db.prepare("PRAGMA table_info(memory_lifecycle_projection_state)").all().map((row) => row.name),
      ["singleton", "schema_version", "projected_rows", "updated_at"],
    );
    assert.deepEqual(
      db.prepare("PRAGMA table_info(memory_lifecycle_projection)").all().map((row) => row.name),
      [
        "memory_id", "scope", "static_lifecycle", "valid_from", "invalidated_at",
        "truth_updated_at", "projection_fingerprint",
      ],
    );
    assert.deepEqual(
      db.prepare("PRAGMA index_info(idx_memory_lifecycle_projection_scope)").all().map((row) => row.name),
      ["scope", "static_lifecycle", "valid_from", "invalidated_at"],
    );
  } finally {
    truth.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary reopen and stats report projection drift without repairing the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-lifecycle-readonly-"));
  const path = join(dir, "memory.sqlite3");
  const truth = new SqlTruthStore(path);
  let reopened;
  try {
    truth.open();
    truth.upsertWithVectorIntent(entry("drift-row", { state: "confirmed" }), "seed");
    const db = truth.getDb();
    const beforeProjection = JSON.stringify(db.prepare(
      "SELECT * FROM memory_lifecycle_projection ORDER BY memory_id",
    ).all());
    const beforeState = JSON.stringify(db.prepare(
      "SELECT * FROM memory_lifecycle_projection_state ORDER BY singleton",
    ).all());
    db.prepare("UPDATE memory_truth SET metadata = ?, updated_at = updated_at + 1 WHERE id = ?")
      .run(JSON.stringify({ state: "archived", lifecycle: "archived" }), "drift-row");
    truth.close();

    reopened = new SqlTruthStore(path);
    reopened.open({ allowCreate: false });
    const reopenedDb = reopened.getDb();
    const stats = reopened.stats();
    assert.equal(stats.lifecycleProjection.ok, false);
    assert.equal(stats.lifecycleProjection.status, "row_revision_mismatch");
    assert.deepEqual(stats.lifecycleScopeCounts, {});
    assert.equal(JSON.stringify(reopenedDb.prepare(
      "SELECT * FROM memory_lifecycle_projection ORDER BY memory_id",
    ).all()), beforeProjection);
    assert.equal(JSON.stringify(reopenedDb.prepare(
      "SELECT * FROM memory_lifecycle_projection_state ORDER BY singleton",
    ).all()), beforeState);

    const repaired = repairLifecycleProjection(reopenedDb);
    assert.equal(repaired.ok, true);
    assert.deepEqual(reopened.stats().lifecycleScopeCounts["agent:main"], {
      recallable: 0,
      archived: 1,
      inactive: 0,
    });
  } finally {
    truth.close();
    reopened?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projection health detects same-revision derived-row drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-lifecycle-derived-drift-"));
  const truth = new SqlTruthStore(join(dir, "memory.sqlite3"));
  try {
    truth.open();
    truth.upsertWithVectorIntent(entry("derived-drift-row", { state: "confirmed" }), "seed");
    const db = truth.getDb();
    const truthUpdatedAt = db.prepare(
      "SELECT updated_at FROM memory_truth WHERE id = ?",
    ).get("derived-drift-row").updated_at;

    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(
      "UPDATE memory_lifecycle_projection SET static_lifecycle = 'archived' WHERE memory_id = ?",
    ).run("derived-drift-row");
    db.exec("PRAGMA ignore_check_constraints = OFF");

    assert.equal(
      db.prepare("SELECT updated_at FROM memory_truth WHERE id = ?").get("derived-drift-row").updated_at,
      truthUpdatedAt,
    );
    const drifted = inspectLifecycleProjection(db);
    assert.equal(drifted.ok, false);
    assert.equal(drifted.status, "row_projection_mismatch");
    const access = openLifecycleProjectionReadAccess(db);
    assert.equal(access.readScopeCounts, null);
    assert.equal(access.health.status, "row_projection_mismatch");

    const repaired = repairLifecycleProjection(db);
    assert.equal(repaired.ok, true);
    assert.equal(db.prepare(
      "SELECT static_lifecycle FROM memory_lifecycle_projection WHERE memory_id = ?",
    ).get("derived-drift-row").static_lifecycle, "dynamic");
  } finally {
    try { truth.getDb().exec("PRAGMA ignore_check_constraints = OFF"); } catch {}
    truth.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projection health rejects a fully self-consistent forged lifecycle projection", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-lifecycle-truth-binding-"));
  const truth = new SqlTruthStore(join(dir, "memory.sqlite3"));
  try {
    truth.open();
    truth.upsertWithVectorIntent(entry("truth-bound-row", { state: "confirmed" }), "seed");
    const db = truth.getDb();
    db.prepare(`
      UPDATE memory_lifecycle_projection
      SET static_lifecycle = 'archived',
          projection_fingerprint = json_array(
            scope,
            'archived',
            CAST(valid_from AS REAL),
            CASE WHEN invalidated_at IS NULL THEN NULL ELSE CAST(invalidated_at AS REAL) END,
            CAST(truth_updated_at AS REAL)
          )
      WHERE memory_id = ?
    `).run("truth-bound-row");

    const drifted = inspectLifecycleProjection(db);
    assert.equal(drifted.ok, false);
    assert.equal(drifted.status, "row_projection_mismatch");

    const repaired = repairLifecycleProjection(db);
    assert.equal(repaired.ok, true);
    assert.equal(db.prepare(
      "SELECT static_lifecycle FROM memory_lifecycle_projection WHERE memory_id = ?",
    ).get("truth-bound-row").static_lifecycle, "dynamic");
  } finally {
    truth.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
