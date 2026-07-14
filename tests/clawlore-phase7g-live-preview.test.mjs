import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createAndVerifyLegacyLiveEncryptedSnapshotV2 } =
  jiti("../src/v2/operator/legacy-live-encrypted-snapshot.ts");
const { createLivePhase7GPreviewV1 } = jiti("../src/v2/operator/live-phase7g-preview.ts");
const { TRUTH_V2_SCHEMA_SQL } = jiti("../src/v2/storage/sqlite-truth-v2.ts");

function sha256(path) {
  return readFile(path).then((value) => createHash("sha256").update(value).digest("hex"));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-phase7g-live-preview-"));
  const source = join(root, "live.sqlite3");
  const archive = join(root, "fresh.clawlore2");
  const restore = join(root, "restore.sqlite3");
  const receipt = join(root, "snapshot.json");
  const key = join(root, "snapshot.key");
  await writeFile(key, Buffer.alloc(32, 7), { mode: 0o600 });
  await chmod(key, 0o600);
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(
    id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
    timestamp REAL NOT NULL,metadata TEXT NOT NULL,metadata_text TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,text,metadata_text);
    ${TRUTH_V2_SCHEMA_SQL}
    CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(item_id UNINDEXED,content,category);`);
  db.exec("BEGIN IMMEDIATE");
  const now = "2026-07-12T12:00:00.000Z";
  const rows = [
    { id: "manual", text: "private fixture", classification: "explicit_manual", verification: "user_confirmed",
      principalId: "telegram:default:fixture", metadata: { source: "manual", sender_id: "fixture", platform: "telegram", l0_abstract: "fixture" } },
    { id: "unknown", text: "opaque fixture", classification: "unknown_legacy", verification: "unverified",
      principalId: "legacy:unresolved", metadata: { source: "unknown", secret: "must-not-emit" } },
  ];
  for (const row of rows) {
    const itemId = `legacy:${row.id}`;
    const revisionId = `revision:${row.id}`;
    const address = { schemaVersion: 2, tenantId: "tenant", principalId: row.principalId, agentId: "main",
      ...(row.principalId === "legacy:unresolved" ? {} : { platform: "telegram", accountId: "default" }),
      visibility: "private", retention: "durable" };
    const metadataText = [row.metadata.l0_abstract, ...(row.metadata.tags || [])].filter(Boolean).join("\n");
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?)")
      .run(row.id, row.text, "other", "agent:main", Date.parse(now), JSON.stringify(row.metadata), metadataText);
    db.prepare("INSERT INTO memory_fts VALUES (?,?,?)").run(row.id, row.text, "fixture");
    db.prepare(`INSERT INTO memory_revisions
      (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
      VALUES (?,?,1,?,'candidate',?,NULL,?)`).run(revisionId, itemId, row.text, row.verification, now);
    db.prepare(`INSERT INTO memory_items
      (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
       visibility,retention,lifecycle,verification,created_at,updated_at)
      VALUES (?,?,1,?,'other',?,'tenant',?,'main','private','durable','candidate',?,?,?)`)
      .run(itemId, revisionId, row.text, JSON.stringify(address), row.principalId, row.verification, now, now);
    db.prepare(`INSERT INTO memory_sources
      (source_id,revision_id,source_type,external_id,observed_at,evidence_json) VALUES (?,?,?,?,?,?)`)
      .run(`source:${row.id}`, revisionId, "legacy", row.id, now, JSON.stringify({ classification: row.classification }));
    db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, row.text, "other");
  }
  db.exec("COMMIT");
  db.close();
  await chmod(source, 0o600);
  await createAndVerifyLegacyLiveEncryptedSnapshotV2({
    sourcePath: source, archivePath: archive, restoreTestPath: restore, receiptPath: receipt,
    keyId: "fixture-key", secretRefPath: key, now: () => new Date(now),
  });
  return { root, source, archive, restore, receipt };
}

test("live Phase 7G preview is snapshot-bound, complete, redacted, and query-only", async () => {
  const paths = await fixture();
  try {
    const before = await sha256(paths.source);
    const result = await createLivePhase7GPreviewV1({
      sourcePath: paths.source,
      snapshotArchivePath: paths.archive,
      snapshotReceiptPath: paths.receipt,
      snapshotRestoreTestPath: paths.restore,
      compatibilityRolloutId: "clawlore-v2-compatibility-fixture-r1",
      promotionRolloutId: "clawlore-v2-promotion-fixture-r1",
      now: () => new Date("2026-07-12T12:10:00.000Z"),
    });
    assert.equal(result.controls.status, "ready");
    assert.equal(result.compatibilityPlan.sourceRows, 2);
    assert.equal(result.compatibilityPlan.v2Rows, 2);
    assert.equal(result.compatibilityPlan.mappingMismatchRows, 0);
    assert.equal(result.compatibilityPlan.bootstrapSource, "memory_truth.metadata_text");
    assert.equal(result.candidatePromotionPlan.rows.length, 2);
    assert.equal(result.candidatePromotionPlan.counts.eligible_for_promotion, 1);
    assert.equal(result.candidatePromotionPlan.counts.quarantine, 1);
    assert.equal(result.liveMutation.lifecycleRowsChanged, 0);
    assert.equal(result.controls.authorizesCompatibilityBackfill, false);
    assert.equal(result.controls.authorizesCandidatePromotion, false);
    assert.equal(JSON.stringify(result).includes("private fixture"), false);
    assert.equal(JSON.stringify(result).includes("must-not-emit"), false);
    assert.equal(await sha256(paths.source), before);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='memory_fts_compat_v2'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE lifecycle='candidate'").get().n, 2);
    db.close();
    assert.equal((await stat(paths.receipt)).mode & 0o077, 0);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("live Phase 7G preview rejects stale snapshot truth and plaintext residue", async () => {
  const paths = await fixture();
  try {
    await writeFile(paths.restore, "residue", { mode: 0o600 });
    const result = await createLivePhase7GPreviewV1({
      sourcePath: paths.source,
      snapshotArchivePath: paths.archive,
      snapshotReceiptPath: paths.receipt,
      snapshotRestoreTestPath: paths.restore,
      compatibilityRolloutId: "clawlore-v2-compatibility-fixture-r2",
      promotionRolloutId: "clawlore-v2-promotion-fixture-r2",
      now: () => new Date("2026-07-12T12:10:00.000Z"),
    });
    assert.equal(result.controls.status, "blocked");
    assert.ok(result.controls.blockers.includes("snapshot_plaintext_residue_present"));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
