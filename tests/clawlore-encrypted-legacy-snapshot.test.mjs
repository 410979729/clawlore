import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url);
const { verifyPrivatePath } = jiti("../src/file-privacy.ts");
const {
  createEncryptedLegacySnapshotArchiveV2,
  createFileSecretRefKeyProviderV2,
  restoreEncryptedLegacySnapshotArchiveV2,
} = jiti("../src/v2/operator/encrypted-snapshot-archive.ts");

test("legacy SQLite archive is encrypted, permission-tight, restorable, and leaves no plaintext", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-encrypted-legacy-"));
  const sourcePath = join(root, "legacy.sqlite3");
  const archivePath = join(root, "backups", "legacy.clawlore2");
  const restoredPath = join(root, "restored.sqlite3");
  const keyPath = join(root, "snapshot.key");
  const db = new DatabaseSync(sourcePath);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE memory_truth (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL,
        scope TEXT NOT NULL, timestamp INTEGER NOT NULL, metadata TEXT NOT NULL
      );`);
    db.prepare(`INSERT INTO memory_truth(id,text,category,scope,timestamp,metadata)
      VALUES(?,?,?,?,?,?)`).run(
      "legacy-one", "Plaintext fixture must not be visible in the archive",
      "fact", "agent:main", 1_783_000_000, "{}",
    );
    await writeFile(keyPath, Buffer.alloc(32, 0x5c), { mode: 0o600 });
    const keyProvider = createFileSecretRefKeyProviderV2({
      keyId: "fixture-legacy-key",
      secretRef: { source: "file", path: keyPath },
    });
    const manifest = await createEncryptedLegacySnapshotArchiveV2({
      sourcePath, archivePath, keyProvider,
    });
    assert.equal(manifest.snapshot.profile, "scope-recall-legacy-v1");
    assert.equal(manifest.snapshot.memoryTruth.rowCount, 1);
    verifyPrivatePath(archivePath, { kind: "file" });
    assert.equal((await readFile(archivePath)).includes(Buffer.from("Plaintext fixture")), false);

    const restored = await restoreEncryptedLegacySnapshotArchiveV2({
      archivePath, destinationPath: restoredPath, expected: manifest, keyProvider,
    });
    assert.equal(restored.memoryTruth.rowCount, 1);
    const restoredDb = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM memory_truth").get().count, 1);
    } finally {
      restoredDb.close();
    }
    const residualNames = (await readdir(root, { recursive: true }))
      .filter((name) => name.includes(".plaintext-") || name.includes(".decrypt-"));
    assert.deepEqual(residualNames, []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
