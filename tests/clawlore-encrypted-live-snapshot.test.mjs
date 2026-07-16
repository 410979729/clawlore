import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url);
const { verifyPrivatePath } = jiti("../src/file-privacy.ts");
const { createAndVerifyLegacyLiveEncryptedSnapshotV2 } = jiti(
  "../src/v2/operator/legacy-live-encrypted-snapshot.ts",
);

async function missing(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test("live encrypted snapshot workflow persists only ciphertext and a non-authorizing receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-live-encrypted-"));
  const sourcePath = join(root, "legacy.sqlite3");
  const archivePath = join(root, "archive", "legacy.clawlore2");
  const restoreTestPath = join(root, "restore", "legacy.sqlite3");
  const receiptPath = join(root, "receipt", "snapshot.json");
  const keyPath = join(root, "backup.key");
  const db = new DatabaseSync(sourcePath);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE memory_truth (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL,
        scope TEXT NOT NULL, timestamp INTEGER NOT NULL, metadata TEXT NOT NULL
      );`);
    db.prepare(`INSERT INTO memory_truth(id,text,category,scope,timestamp,metadata)
      VALUES(?,?,?,?,?,?)`).run("one", "ciphertext only", "fact", "agent:main", 1, "{}");
    await writeFile(keyPath, Buffer.alloc(32, 0x42), { mode: 0o600 });
    const receipt = await createAndVerifyLegacyLiveEncryptedSnapshotV2({
      sourcePath,
      archivePath,
      restoreTestPath,
      receiptPath,
      keyId: "fixture-live-key",
      secretRefPath: keyPath,
      now: () => new Date("2026-07-12T09:00:00.000Z"),
    });
    assert.equal(receipt.status, "pass");
    assert.equal(receipt.authorizesV2Writes, false);
    assert.equal(receipt.restoreVerified, true);
    assert.equal(receipt.snapshot.memoryTruthRows, 1);
    verifyPrivatePath(archivePath, { kind: "file" });
    verifyPrivatePath(receiptPath, { kind: "file" });
    assert.equal((await readFile(archivePath)).includes(Buffer.from("ciphertext only")), false);
    assert.equal(await missing(restoreTestPath), true);
    assert.equal(await missing(`${restoreTestPath}-wal`), true);
    assert.equal(await missing(`${restoreTestPath}-shm`), true);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("live encrypted snapshot workflow preserves a pre-existing restore-test destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-live-encrypted-existing-"));
  const sourcePath = join(root, "legacy.sqlite3");
  const archivePath = join(root, "legacy.clawlore2");
  const restoreTestPath = join(root, "existing.sqlite3");
  const receiptPath = join(root, "snapshot.json");
  const keyPath = join(root, "backup.key");
  const db = new DatabaseSync(sourcePath);
  try {
    db.exec(`CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL,
      scope TEXT NOT NULL, timestamp INTEGER NOT NULL, metadata TEXT NOT NULL
    );`);
    await writeFile(keyPath, Buffer.alloc(32, 0x33), { mode: 0o600 });
    await writeFile(restoreTestPath, "preserve-me", { mode: 0o600 });
    await assert.rejects(
      () => createAndVerifyLegacyLiveEncryptedSnapshotV2({
        sourcePath,
        archivePath,
        restoreTestPath,
        receiptPath,
        keyId: "fixture-existing-key",
        secretRefPath: keyPath,
      }),
      /restore-test destination already exists/,
    );
    assert.equal(await readFile(restoreTestPath, "utf8"), "preserve-me");
    assert.equal(await missing(archivePath), true);
    assert.equal(await missing(receiptPath), true);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
