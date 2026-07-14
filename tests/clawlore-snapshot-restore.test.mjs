import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SqliteTruthStoreV2 } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const {
  createVerifiedSqliteSnapshotV2,
  inspectSqliteSnapshotV2,
  restoreVerifiedSqliteSnapshotV2,
} = jiti("../src/v2/operator/sqlite-snapshot.ts");

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
  return { now: () => new Date("2026-07-11T13:00:00.000Z"), id: () => `snapshot-${++sequence}` };
}

test("online snapshot remains consistent while the source store stays open and restores to a new path", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-snapshot-"));
  const sourcePath = join(root, "source.sqlite");
  const snapshotPath = join(root, "backups", "snapshot.sqlite");
  const restoredPath = join(root, "restore", "truth.sqlite");
  const source = new SqliteTruthStoreV2(sourcePath, clock());
  let restored;
  try {
    source.open();
    source.remember({
      itemId: "before-snapshot",
      content: "Vector and graph projections rebuild from SQL truth",
      category: "decision",
      address: address(),
      verification: "operator_reviewed",
      source: { sourceType: "operator", observedAt: "2026-07-11T12:59:00Z" },
      actor: "operator",
      reason: "snapshot fixture",
    });
    const manifest = await createVerifiedSqliteSnapshotV2({
      sourcePath,
      destinationPath: snapshotPath,
      now: () => new Date("2026-07-11T13:00:00.000Z"),
    });
    assert.equal(manifest.integrity, "ok");
    assert.equal(manifest.foreignKeyViolations, 0);
    assert.equal(manifest.truthSchemaVersion, 3);
    assert.equal(manifest.tableCounts.memory_item_identities, 1);
    assert.equal(manifest.tableCounts.memory_items, 1);
    assert.equal(manifest.tableCounts.projection_outbox, 3);

    source.remember({
      itemId: "after-snapshot",
      content: "This later write must not appear in the restored snapshot",
      category: "fact",
      address: address(),
      source: { sourceType: "operator", observedAt: "2026-07-11T13:01:00Z" },
      actor: "operator",
      reason: "post snapshot fixture",
    });
    assert.equal(source.count("memory_items"), 2);

    const restoredManifest = await restoreVerifiedSqliteSnapshotV2({
      snapshotPath,
      destinationPath: restoredPath,
      expected: manifest,
      now: () => new Date("2026-07-11T13:02:00.000Z"),
    });
    assert.equal(restoredManifest.tableCounts.memory_items, 1);
    restored = new SqliteTruthStoreV2(restoredPath, clock());
    restored.open();
    assert.equal(restored.get("before-snapshot").content, "Vector and graph projections rebuild from SQL truth");
    assert.equal(restored.get("after-snapshot"), null);
  } finally {
    restored?.close();
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restore rejects a tampered snapshot and leaves no destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-snapshot-tamper-"));
  const sourcePath = join(root, "source.sqlite");
  const snapshotPath = join(root, "snapshot.sqlite");
  const destinationPath = join(root, "restore.sqlite");
  const source = new SqliteTruthStoreV2(sourcePath, clock());
  try {
    source.open();
    source.remember({
      content: "tamper fixture",
      category: "fact",
      address: address(),
      source: { sourceType: "operator", observedAt: "2026-07-11T13:00:00Z" },
      actor: "operator",
      reason: "snapshot fixture",
    });
    const manifest = await createVerifiedSqliteSnapshotV2({ sourcePath, destinationPath: snapshotPath });
    await appendFile(snapshotPath, "tamper");
    await assert.rejects(
      () => restoreVerifiedSqliteSnapshotV2({ snapshotPath, destinationPath, expected: manifest }),
      /checksum mismatch/,
    );
    await assert.rejects(() => inspectSqliteSnapshotV2(destinationPath));
  } finally {
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});
