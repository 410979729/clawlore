import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as lancedb from "@lancedb/lancedb";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryMigrator } = jiti("../src/migrate.ts");

test("legacy migration fails closed when the source table is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-migration-missing-table-"));
  try {
    const db = await lancedb.connect(root);
    const table = await db.createTable("not_memories", [{
      id: "fixture",
      vector: [1, 0, 0, 0],
    }]);
    table.close();
    db.close();

    const migrator = new MemoryMigrator({});
    const result = await migrator.migrate({ sourceDbPath: root });
    assert.equal(result.success, false);
    assert.equal(result.migratedCount, 0);
    assert.match(result.summary, /failed due to unexpected error/);
    assert.ok(result.errors.some((entry) => entry.startsWith("MIGRATION_FAILED:")));

    const needed = await migrator.checkMigrationNeeded(root);
    assert.deepEqual(needed, {
      needed: true,
      sourceFound: true,
      sourceDbPath: root,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy migration reports no data only after opening a valid empty table", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-migration-empty-table-"));
  try {
    const db = await lancedb.connect(root);
    const table = await db.createTable("memories", [{
      id: "deleted-fixture",
      text: "Fixture row",
      vector: [1, 0, 0, 0],
      importance: 0.5,
      category: "fact",
      createdAt: 1,
      scope: "agent:test",
    }]);
    await table.delete("id = 'deleted-fixture'");
    table.close();
    db.close();

    const migrator = new MemoryMigrator({});
    const result = await migrator.migrate({ sourceDbPath: root });
    assert.deepEqual(result, {
      success: true,
      migratedCount: 0,
      skippedCount: 0,
      errors: [],
      summary: "Migration completed: No data to migrate",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
