import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  applyLegacyMigrationV2,
  planLegacyMigrationV2,
  rollbackLegacyMigrationV2,
} = jiti("../src/v2/migration/legacy-v2-migration.ts");
const { SqliteTruthStoreV2 } = jiti("../src/v2/storage/sqlite-truth-v2.ts");

async function hash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

test("legacy migration is preview-bound, additive, verification-debt aware, and rollbackable", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-migration-drill-"));
  const legacyPath = join(root, "legacy.sqlite");
  const destinationPath = join(root, "v2.sqlite");
  const defaults = { tenantId: "local", agentId: "main", workspaceId: "workspace-main" };
  let migrated;
  try {
    const db = new DatabaseSync(legacyPath);
    db.exec(`CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0,timestamp REAL NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',metadata_text TEXT NOT NULL DEFAULT '',updated_at REAL NOT NULL DEFAULT 0
    )`);
    const insert = db.prepare("INSERT INTO memory_truth(id,text,category,scope,timestamp,metadata) VALUES (?,?,?,?,?,?)");
    insert.run("manual", "Use Chinese by default", "preference", "agent:main", 1_700_000_000,
      JSON.stringify({ source: "manual_user", platform: "telegram", senderId: "user-1", verification: "user_confirmed" }));
    insert.run("capture", "Possible inferred preference", "preference", "agent:main", 1_700_000_001,
      JSON.stringify({ source: "smart_extraction" }));
    insert.run("archived", "Old port value", "fact", "agent:main", 1_700_000_002,
      JSON.stringify({ source: "manual_user", platform: "telegram", senderId: "user-1", state: "archived" }));
    db.close();

    const legacyBefore = await hash(legacyPath);
    const plan = planLegacyMigrationV2({ legacyPath, defaults });
    assert.equal(plan.readOnly, true);
    assert.equal(plan.totalRows, 3);
    assert.equal(plan.activeRows, 1);
    assert.equal(plan.candidateRows, 1);
    assert.equal(plan.archivedRows, 1);
    assert.equal(await hash(legacyPath), legacyBefore);

    const receipt = await applyLegacyMigrationV2({
      legacyPath,
      destinationPath,
      defaults,
      expectedPlanDigest: plan.planDigest,
      now: () => new Date("2026-07-11T14:00:00Z"),
      id: () => "migration-fixture-1",
    });
    assert.equal(receipt.rowsApplied, 3);
    assert.equal(await hash(legacyPath), legacyBefore);

    migrated = new SqliteTruthStoreV2(destinationPath);
    migrated.open();
    assert.equal(migrated.get("legacy:manual").lifecycle, "active");
    assert.equal(migrated.get("legacy:manual").verification, "user_confirmed");
    assert.equal(migrated.get("legacy:capture").lifecycle, "candidate");
    assert.equal(migrated.get("legacy:capture").address.principalId, "legacy:unresolved");
    assert.equal(migrated.get("legacy:archived").lifecycle, "archived");
    migrated.close();
    migrated = undefined;

    const rollback = await rollbackLegacyMigrationV2({
      destinationPath,
      migrationId: receipt.migrationId,
      planDigest: receipt.planDigest,
    });
    assert.equal(rollback.rolledBack, true);
    await assert.rejects(() => access(destinationPath));
    await assert.rejects(() => access(receipt.markerPath));
    assert.equal(await hash(legacyPath), legacyBefore);
  } finally {
    migrated?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy migration rejects stale preview digests before creating a destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-migration-stale-"));
  const legacyPath = join(root, "legacy.sqlite");
  const destinationPath = join(root, "v2.sqlite");
  try {
    const db = new DatabaseSync(legacyPath);
    db.exec("CREATE TABLE memory_truth (id TEXT PRIMARY KEY,text TEXT,category TEXT,scope TEXT,timestamp REAL,metadata TEXT)");
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)").run("one", "fact", "fact", "agent:main", 1, "{}");
    db.close();
    await assert.rejects(() => applyLegacyMigrationV2({
      legacyPath,
      destinationPath,
      defaults: { tenantId: "local", agentId: "main" },
      expectedPlanDigest: "stale",
    }), /plan digest mismatch/);
    await assert.rejects(() => access(destinationPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
