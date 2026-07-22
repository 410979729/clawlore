import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createAndVerifyGenericLiveEncryptedSnapshotV2 } = jiti(
  "../src/v2/operator/generic-live-encrypted-snapshot.ts",
);

test("generic live SQLite snapshot is encrypted, restored, source-bound, and content-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-generic-snapshot-"));
  const sourcePath = join(root, "conversation.sqlite3");
  const archivePath = join(root, "conversation.clawlore2");
  const restoreTestPath = join(root, "restore-test.sqlite3");
  const receiptPath = join(root, "receipt.json");
  const keyPath = join(root, "snapshot.key");
  const secretText = "fixture conversation material must only exist inside the encrypted archive";
  try {
    const db = new DatabaseSync(sourcePath);
    db.exec("CREATE TABLE conversations(id INTEGER PRIMARY KEY,detail TEXT NOT NULL)");
    db.prepare("INSERT INTO conversations(detail) VALUES(?)").run(secretText);
    db.close();
    await chmod(sourcePath, 0o600);
    await writeFile(keyPath, Buffer.alloc(32, 0x6a), { mode: 0o600 });
    const receipt = await createAndVerifyGenericLiveEncryptedSnapshotV2({
      sourcePath,
      archivePath,
      restoreTestPath,
      receiptPath,
      keyId: "fixture-generic-key",
      secretRefPath: keyPath,
      now: () => new Date("2026-07-22T02:00:00Z"),
    });
    assert.equal(receipt.status, "pass");
    assert.equal(receipt.restoreVerified, true);
    assert.equal(receipt.snapshot.profile, "generic-sqlite-v1");
    assert.equal(receipt.snapshot.rowCount, 1);
    assert.equal((await readFile(archivePath)).includes(Buffer.from(secretText)), false);
    assert.equal(JSON.stringify(receipt).includes(secretText), false);
    await assert.rejects(stat(restoreTestPath), /ENOENT/);
    if (process.platform !== "win32") {
      assert.equal((await stat(archivePath)).mode & 0o077, 0);
      assert.equal((await stat(receiptPath)).mode & 0o077, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
