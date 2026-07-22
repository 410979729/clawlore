import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as lancedb from "@lancedb/lancedb";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createAndVerifyVectorCompanionLiveEncryptedSnapshotV2 } = jiti(
  "../src/v2/operator/vector-companion-live-encrypted-snapshot.ts",
);

test("vector companion snapshot is encrypted, actually restorable, and leaves no plaintext tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-vector-snapshot-"));
  const sourceRoot = join(root, "source");
  const evidenceRoot = join(root, "evidence");
  const archivePath = join(evidenceRoot, "vector.clawlore2");
  const receiptPath = join(evidenceRoot, "receipt.json");
  const restoreTestRoot = join(root, "restore-test");
  const keyPath = join(root, "snapshot.key");
  const secretText = "fixture vector plaintext must remain encrypted at rest";
  try {
    const db = await lancedb.connect(sourceRoot);
    const table = await db.createTable("memories", [{
      id: "memory-one",
      text: secretText,
      metadata: "{}",
      vector: [1, 0, 0, 0],
    }]);
    await table.close?.();
    await db.close?.();
    await writeFile(keyPath, Buffer.alloc(32, 0x4c), { mode: 0o600 });
    await chmod(keyPath, 0o600);

    const receipt = await createAndVerifyVectorCompanionLiveEncryptedSnapshotV2({
      sourceRoot,
      archivePath,
      restoreTestRoot,
      receiptPath,
      keyId: "fixture-vector-key",
      secretRefPath: keyPath,
      now: () => new Date("2026-07-22T03:00:00Z"),
    });
    assert.equal(receipt.status, "pass");
    assert.equal(receipt.restoreVerified, true);
    assert.equal(receipt.vector.rowCount, 1);
    assert.equal(receipt.vector.table, "memories");
    assert.equal((await readFile(archivePath)).includes(Buffer.from(secretText)), false);
    assert.equal(JSON.stringify(receipt).includes(secretText), false);
    await assert.rejects(stat(restoreTestRoot), /ENOENT/);
    assert.deepEqual((await readdir(evidenceRoot)).sort(), ["receipt.json", "vector.clawlore2"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(archivePath)).mode & 0o077, 0);
      assert.equal((await stat(receiptPath)).mode & 0o077, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
