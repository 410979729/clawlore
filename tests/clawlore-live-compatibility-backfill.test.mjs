import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createAndVerifyLegacyLiveEncryptedSnapshotV2 } =
  jiti("../src/v2/operator/legacy-live-encrypted-snapshot.ts");
const { createLivePhase7GPreviewV1 } = jiti("../src/v2/operator/live-phase7g-preview.ts");
const { executeLiveCompatibilityBackfillV1 } = jiti("../src/v2/operator/live-compatibility-backfill.ts");
const { TRUTH_V2_SCHEMA_SQL } = jiti("../src/v2/storage/sqlite-truth-v2.ts");

async function privateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-compat-backfill-"));
  const source = join(root, "live.sqlite3");
  const archive = join(root, "fresh.clawlore2");
  const restore = join(root, "restore.sqlite3");
  const snapshotReceipt = join(root, "snapshot.json");
  const previewPath = join(root, "preview.json");
  const key = join(root, "snapshot.key");
  await writeFile(key, Buffer.alloc(32, 9), { mode: 0o600 });
  await chmod(key, 0o600);
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(
    id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
    timestamp REAL NOT NULL,metadata TEXT NOT NULL,metadata_text TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,text,metadata_text);
    ${TRUTH_V2_SCHEMA_SQL}
    CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(item_id UNINDEXED,content,category);
    CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY,legacy_id TEXT,backend TEXT,state TEXT,verified_at TEXT);
    CREATE TABLE memory_relation_projection_v2(item_id TEXT PRIMARY KEY,state TEXT,verified_at TEXT);`);
  db.exec("BEGIN IMMEDIATE");
  const now = "2026-07-12T12:00:00.000Z";
  const rows = [
    { id: "one", text: "alpha memory", metadataText: "searchable synopsis", metadata: { l0_abstract: "stale raw value", sender_id: "private-id" } },
    { id: "two", text: "beta memory", metadataText: "safe-tag", metadata: { tags: ["stale-raw-tag"], raw_secret: "must-not-copy" } },
  ];
  for (const row of rows) {
    const itemId = `legacy:${row.id}`;
    const revisionId = `revision:${row.id}`;
    const address = { schemaVersion: 2, tenantId: "tenant", principalId: "legacy:unresolved", agentId: "main",
      visibility: "private", retention: "durable" };
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?)")
      .run(row.id, row.text, "other", "agent:main", Date.parse(now), JSON.stringify(row.metadata), row.metadataText);
    db.prepare("INSERT INTO memory_fts VALUES (?,?,?)").run(row.id, row.text, row.metadataText);
    db.prepare(`INSERT INTO memory_revisions
      (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
      VALUES (?,?,1,?,'candidate','unverified',NULL,?)`).run(revisionId, itemId, row.text, now);
    db.prepare(`INSERT INTO memory_items
      (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
       visibility,retention,lifecycle,verification,created_at,updated_at)
      VALUES (?,?,1,?,'other',?,'tenant','legacy:unresolved','main','private','durable','candidate','unverified',?,?)`)
      .run(itemId, revisionId, row.text, JSON.stringify(address), now, now);
    db.prepare(`INSERT INTO memory_sources
      (source_id,revision_id,source_type,external_id,observed_at,evidence_json) VALUES (?,?,?,?,?,?)`)
      .run(`source:${row.id}`, revisionId, "legacy", row.id, now, JSON.stringify({ classification: "unknown_legacy" }));
    db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, row.text, "other");
    db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)")
      .run(itemId, row.id, "fixture", "fallback_verified", now);
    db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)")
      .run(itemId, "fixture", now);
  }
  db.exec("COMMIT");
  db.close();
  await chmod(source, 0o600);
  await createAndVerifyLegacyLiveEncryptedSnapshotV2({
    sourcePath: source, archivePath: archive, restoreTestPath: restore, receiptPath: snapshotReceipt,
    keyId: "fixture-key", secretRefPath: key, now: () => new Date(now),
  });
  const preview = await createLivePhase7GPreviewV1({
    sourcePath: source, snapshotArchivePath: archive, snapshotReceiptPath: snapshotReceipt,
    snapshotRestoreTestPath: restore, compatibilityRolloutId: "clawlore-v2-compat-fixture-r1",
    promotionRolloutId: "clawlore-v2-promotion-fixture-r1", now: () => new Date("2026-07-12T12:10:00.000Z"),
  });
  await privateJson(previewPath, preview);
  return { root, source, previewPath, preview };
}

test("compatibility backfill is digest-bound and leaves canonical lifecycle unchanged", async () => {
  const paths = await fixture();
  try {
    const receipt = await executeLiveCompatibilityBackfillV1({
      sourcePath: paths.source,
      previewPath: paths.previewPath,
      rolloutId: "clawlore-v2-compat-fixture-r1",
      planDigest: paths.preview.compatibilityPlan.planDigest,
      now: () => new Date("2026-07-12T12:12:00.000Z"),
    });
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.projection.rows, 2);
    assert.equal(receipt.projection.canonicalMemoryItemsChanged, 0);
    assert.equal(receipt.projection.lifecycleRowsChanged, 0);
    assert.equal(receipt.runtime.lifecycleMutationEnabled, false);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_fts_compat_v2").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_fts_compat_v2 WHERE memory_fts_compat_v2 MATCH 'synopsis'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_fts_compat_v2 WHERE memory_fts_compat_v2 MATCH '\"private-id\"'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_fts_compat_v2 WHERE memory_fts_compat_v2 MATCH '\"must-not-copy\"'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_fts_compat_v2 WHERE memory_fts_compat_v2 MATCH '\"stale raw value\"'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE lifecycle='candidate'").get().n, 2);
    db.close();
    await assert.rejects(() => executeLiveCompatibilityBackfillV1({
      sourcePath: paths.source,
      previewPath: paths.previewPath,
      rolloutId: "clawlore-v2-compat-fixture-r1",
      planDigest: paths.preview.compatibilityPlan.planDigest,
      now: () => new Date("2026-07-12T12:12:00.000Z"),
    }), /already exists/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("compatibility backfill rejects a stale preview or mismatched digest before mutation", async () => {
  const paths = await fixture();
  try {
    await assert.rejects(() => executeLiveCompatibilityBackfillV1({
      sourcePath: paths.source,
      previewPath: paths.previewPath,
      rolloutId: "clawlore-v2-compat-fixture-r1",
      planDigest: "f".repeat(64),
      now: () => new Date("2026-07-12T12:12:00.000Z"),
    }), /invalid|mismatch/);
    await assert.rejects(() => executeLiveCompatibilityBackfillV1({
      sourcePath: paths.source,
      previewPath: paths.previewPath,
      rolloutId: "clawlore-v2-compat-fixture-r1",
      planDigest: paths.preview.compatibilityPlan.planDigest,
      now: () => new Date("2026-07-12T13:30:01.000Z"),
    }), /stale/);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='memory_fts_compat_v2'").get().n, 0);
    db.close();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
