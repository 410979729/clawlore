import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureFreshInstallV2AuthorityV1 } from "../dist/src/fresh-install-v2-authority.js";

const root = await mkdtemp(join(tmpdir(), "clawlore-packed-fresh-v2-"));
const path = join(root, "memory.sqlite3");
try {
  const initial = new DatabaseSync(path);
  initial.exec(`CREATE TABLE memory_truth (
    id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
    importance REAL NOT NULL,timestamp REAL NOT NULL,metadata TEXT NOT NULL,
    metadata_text TEXT NOT NULL,updated_at REAL NOT NULL
  )`);
  initial.close();

  const result = ensureFreshInstallV2AuthorityV1(path);
  assert.equal(result.authority, "fresh-v2");
  assert.equal(result.mayActivateWithoutMigrationReceipt, true);
  const verify = new DatabaseSync(path, { readOnly: true });
  assert.equal(verify.prepare("SELECT MAX(version) AS version FROM clawlore_schema").get().version, 3);
  assert.equal(verify.prepare("SELECT authority FROM clawlore_runtime_authority").get().authority, "fresh-v2");
  assert.equal(verify.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(verify.prepare("PRAGMA foreign_key_check").all().length, 0);
  verify.close();
  process.stdout.write("packed fresh V2 smoke ok\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
