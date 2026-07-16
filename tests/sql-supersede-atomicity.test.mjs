import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SqlTruthStore } = jiti("../src/sql-truth-store.ts");
const { verifyPrivatePath } = jiti("../src/file-privacy.ts");

function entry(id, metadata) {
  return {
    id,
    text: id.includes("new") ? "new preference" : "old preference",
    vector: [],
    category: "preference",
    scope: "user:fixture",
    importance: 0.8,
    timestamp: id.includes("new") ? 2 : 1,
    metadata: JSON.stringify(metadata),
  };
}

test("SQL supersede rolls back both revisions on predecessor patch failure and keeps files 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-atomic-supersede-"));
  const sqlitePath = join(root, "memory.sqlite3");
  const store = new SqlTruthStore(sqlitePath);
  try {
    store.open();
    const oldActive = entry("old-1", { fact_key: "preference:theme", valid_from: 1 });
    store.upsert(oldActive);
    for (const path of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
      if (existsSync(path)) verifyPrivatePath(path, { kind: "file" });
    }

    const db = store.getDb();
    db.exec(`
      CREATE TRIGGER fail_predecessor_patch
      BEFORE UPDATE ON memory_truth
      WHEN OLD.id = 'old-1'
      BEGIN
        SELECT RAISE(ABORT, 'fault injection: predecessor patch failed');
      END;
    `);
    const newActive = entry("new-1", {
      fact_key: "preference:theme",
      valid_from: 2,
      supersedes: "old-1",
    });
    const oldInvalidated = entry("old-1", {
      fact_key: "preference:theme",
      valid_from: 1,
      invalidated_at: 2,
      superseded_by: "new-1",
    });
    assert.throws(
      () => store.supersedeAtomically(oldInvalidated, newActive, "preference:theme"),
      /fault injection: predecessor patch failed/,
    );
    assert.equal(store.getById("new-1"), null);
    assert.deepEqual(JSON.parse(store.getById("old-1").metadata), JSON.parse(oldActive.metadata));

    db.exec("DROP TRIGGER fail_predecessor_patch");
    store.supersedeAtomically(oldInvalidated, newActive, "preference:theme");
    assert.equal(JSON.parse(store.getById("old-1").metadata).superseded_by, "new-1");
    assert.equal(JSON.parse(store.getById("new-1").metadata).supersedes, "old-1");
    const active = db.prepare(`
      SELECT id FROM memory_truth
      WHERE scope='user:fixture'
        AND json_extract(metadata,'$.fact_key')='preference:theme'
        AND COALESCE(json_extract(metadata,'$.invalidated_at'),0)=0
        AND COALESCE(json_extract(metadata,'$.superseded_by'),'')=''
    `).all();
    assert.deepEqual(active.map((row) => row.id), ["new-1"]);
    assert.throws(
      () => store.upsert(entry("new-2", { fact_key: "preference:theme", valid_from: 3 })),
      /active fact_key uniqueness violation/,
    );
    assert.equal(store.getById("new-2"), null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
