import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { ensureFreshInstallV2AuthorityV1 } =
  jiti("../src/fresh-install-v2-authority.ts");

test("an empty fresh store receives durable V2 authority and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-fresh-v2-"));
  const path = join(root, "memory.sqlite3");
  const { DatabaseSync } = require("node:sqlite");
  const initial = new DatabaseSync(path);
  initial.exec(`CREATE TABLE memory_truth (
    id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
    importance REAL NOT NULL,timestamp REAL NOT NULL,metadata TEXT NOT NULL,
    metadata_text TEXT NOT NULL,updated_at REAL NOT NULL
  )`);
  initial.close();

  const first = ensureFreshInstallV2AuthorityV1(path);
  assert.equal(first.authority, "fresh-v2");
  assert.equal(first.mayActivateWithoutMigrationReceipt, true);
  assert.deepEqual(ensureFreshInstallV2AuthorityV1(path), first);

  const verify = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(verify.prepare("SELECT authority FROM clawlore_runtime_authority").get().authority, "fresh-v2");
    assert.equal(verify.prepare("SELECT MAX(version) AS version FROM clawlore_schema").get().version, 3);
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM memory_items").get().n, 0);
    assert.equal(verify.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(verify.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    verify.close();
  }
  await rm(root, { recursive: true, force: true });
});

test("an existing V1 store is never auto-migrated or marked V2 authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-existing-v1-"));
  const path = join(root, "memory.sqlite3");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE memory_truth (
    id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
    importance REAL NOT NULL,timestamp REAL NOT NULL,metadata TEXT NOT NULL,
    metadata_text TEXT NOT NULL,updated_at REAL NOT NULL
  )`);
  db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?,?,?)").run(
    "legacy-1", "existing memory", "fact", "agent:main", 0.7, Date.now(), "{}", "", Date.now(),
  );
  db.close();

  const result = ensureFreshInstallV2AuthorityV1(path);
  assert.equal(result.authority, "legacy-or-migrated");
  assert.equal(result.mayActivateWithoutMigrationReceipt, false);
  const verify = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      verify.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='memory_items'").get().n,
      0,
    );
    assert.equal(
      verify.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='clawlore_runtime_authority'").get().n,
      0,
    );
  } finally {
    verify.close();
  }
  await rm(root, { recursive: true, force: true });
});
