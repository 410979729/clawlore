import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { verifyPrivatePath } = jiti("../src/file-privacy.ts");
const { SqliteTruthStoreV2 } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const {
  createEncryptedSnapshotArchiveV2,
  createFileSecretRefKeyProviderV2,
  restoreEncryptedSnapshotArchiveV2,
} = jiti("../src/v2/operator/encrypted-snapshot-archive.ts");

function address() {
  return {
    schemaVersion: 2,
    tenantId: "local",
    principalId: "user-1",
    agentId: "main",
    visibility: "private",
    retention: "durable",
  };
}

function clock() {
  let sequence = 0;
  return { now: () => new Date("2026-07-11T14:00:00.000Z"), id: () => `archive-${++sequence}` };
}

async function missing(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test("encrypted archive restores verified Truth V2 without retaining plaintext snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-encrypted-archive-"));
  const sourcePath = join(root, "source.sqlite");
  const archivePath = join(root, "backups", "truth.clawlore2");
  const keyPath = join(root, "secrets", "backup.key");
  const destinationPath = join(root, "restore", "truth.sqlite");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(keyPath, Buffer.alloc(32, 0x7a), { mode: 0o600 });
  const provider = createFileSecretRefKeyProviderV2({
    keyId: "fixture-key-2026-07",
    secretRef: { source: "file", path: keyPath },
  });
  const source = new SqliteTruthStoreV2(sourcePath, clock());
  let restored;
  try {
    source.open();
    source.remember({
      itemId: "encrypted-item",
      content: "Sensitive fixture must never appear as plaintext in the archive",
      category: "decision",
      address: address(),
      verification: "operator_reviewed",
      source: { sourceType: "operator", observedAt: "2026-07-11T13:59:00Z" },
      actor: "operator",
      reason: "encrypted archive fixture",
    });
    const manifest = await createEncryptedSnapshotArchiveV2({
      sourcePath,
      archivePath,
      keyProvider: provider,
      now: () => new Date("2026-07-11T14:00:00.000Z"),
    });
    assert.equal(manifest.algorithm, "aes-256-gcm");
    assert.equal(manifest.keyId, "fixture-key-2026-07");
    assert.equal(manifest.snapshot.tableCounts.memory_items, 1);
    verifyPrivatePath(archivePath, { kind: "file" });
    const archive = await readFile(archivePath);
    assert.equal(archive.includes(Buffer.from("Sensitive fixture")), false);
    assert.equal(archive.includes(Buffer.alloc(32, 0x7a)), false);
    assert.deepEqual((await readdir(join(root, "backups"))).filter((name) => name.includes("plaintext-")), []);

    const restoredManifest = await restoreEncryptedSnapshotArchiveV2({
      archivePath,
      destinationPath,
      expected: manifest,
      keyProvider: provider,
      now: () => new Date("2026-07-11T14:01:00.000Z"),
    });
    assert.equal(restoredManifest.tableCounts.memory_items, 1);
    restored = new SqliteTruthStoreV2(destinationPath, clock());
    restored.open();
    assert.equal(restored.get("encrypted-item").content, "Sensitive fixture must never appear as plaintext in the archive");
    assert.deepEqual((await readdir(join(root, "restore"))).filter((name) => name.includes(".decrypt-")), []);
  } finally {
    restored?.close();
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("file SecretRef rejects insecure POSIX mode and hardens the Windows DACL", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-key-permissions-"));
  const keyPath = join(root, "backup.key");
  try {
    await writeFile(keyPath, Buffer.alloc(32, 0x31), { mode: 0o600 });
    await chmod(keyPath, 0o640);
    const provider = createFileSecretRefKeyProviderV2({
      keyId: "unsafe-key",
      secretRef: { source: "file", path: keyPath },
    });
    if (process.platform === "win32") {
      await provider.current();
      verifyPrivatePath(keyPath, { kind: "file" });
    } else {
      await assert.rejects(() => provider.current(), /permissions must be 0600 or stricter/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wrong archive key fails authentication and leaves no restored database", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-wrong-archive-key-"));
  const sourcePath = join(root, "source.sqlite");
  const archivePath = join(root, "truth.clawlore2");
  const keyPath = join(root, "correct.key");
  const wrongKeyPath = join(root, "wrong.key");
  const destinationPath = join(root, "restore.sqlite");
  await writeFile(keyPath, Buffer.alloc(32, 0x11), { mode: 0o600 });
  await writeFile(wrongKeyPath, Buffer.alloc(32, 0x22), { mode: 0o600 });
  const correct = createFileSecretRefKeyProviderV2({ keyId: "rotatable-key", secretRef: { source: "file", path: keyPath } });
  const wrong = createFileSecretRefKeyProviderV2({ keyId: "rotatable-key", secretRef: { source: "file", path: wrongKeyPath } });
  const source = new SqliteTruthStoreV2(sourcePath, clock());
  try {
    source.open();
    source.remember({
      content: "authentication fixture",
      category: "fact",
      address: address(),
      source: { sourceType: "operator", observedAt: "2026-07-11T14:00:00Z" },
      actor: "operator",
      reason: "wrong key fixture",
    });
    const manifest = await createEncryptedSnapshotArchiveV2({ sourcePath, archivePath, keyProvider: correct });
    await assert.rejects(
      () => restoreEncryptedSnapshotArchiveV2({
        archivePath,
        destinationPath,
        expected: manifest,
        keyProvider: wrong,
      }),
      /authentication failed/,
    );
    assert.equal(await missing(destinationPath), true);
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".decrypt-")), []);
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});
