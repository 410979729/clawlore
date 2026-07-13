import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { TRUTH_V2_SCHEMA_SQL } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const { inspectLegacySqliteSnapshotV2 } = jiti("../src/v2/operator/legacy-v1-snapshot.ts");
const { createLiveV1AppendDeltaPlanV1 } = jiti("../src/v2/operator/live-v1-append-delta-plan.ts");
const { executeLiveV1AppendDeltaV1 } = jiti("../src/v2/operator/live-v1-append-delta-apply.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function privateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-live-v1-delta-"));
  const source = join(root, "live.sqlite3");
  const baseline = join(root, "baseline.json");
  const planPath = join(root, "plan.json");
  const snapshotArchive = join(root, "fresh.clawlore2");
  const snapshotReceipt = join(root, "snapshot.json");
  const rolloutId = "clawlore-v2-v1-delta-migration-fixture-r1";
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(
      id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
      timestamp REAL NOT NULL,metadata TEXT NOT NULL,metadata_text TEXT NOT NULL);
    ${TRUTH_V2_SCHEMA_SQL}
    CREATE VIRTUAL TABLE memory_fts_compat_v2 USING fts5(item_id UNINDEXED,content,metadata_text);
    CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(item_id UNINDEXED,content,category);
    CREATE TABLE memory_vector_projection_v2(
      item_id TEXT PRIMARY KEY,legacy_id TEXT NOT NULL UNIQUE,backend TEXT NOT NULL,
      state TEXT NOT NULL,verified_at TEXT NOT NULL);
    CREATE TABLE memory_relation_projection_v2(
      item_id TEXT PRIMARY KEY,state TEXT NOT NULL,verified_at TEXT NOT NULL);
    CREATE TABLE clawlore_rollouts_v2(
      rollout_id TEXT PRIMARY KEY,plan_digest TEXT NOT NULL,approval_sha256 TEXT NOT NULL,
      readiness_sha256 TEXT NOT NULL,legacy_logical_digest TEXT NOT NULL,rows_applied INTEGER NOT NULL,
      applied_at TEXT NOT NULL,v1_fallback_reads INTEGER NOT NULL,context_engine_enabled INTEGER NOT NULL,
      final_recall_cutover_enabled INTEGER NOT NULL);`);
  const now = "2026-07-12T15:00:00.000Z";
  db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?)").run(
    "existing", "Existing truth", "fact", "agent:main", 1,
    JSON.stringify({ source: "smart_extraction" }), "existing metadata",
  );
  db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?)").run(
    "delta", "Delta reflection", "other", "agent:main", 2,
    JSON.stringify({ source: "reflection-summary", state: "active" }), "delta metadata",
  );
  const address = JSON.stringify({
    schemaVersion: 2,
    tenantId: "local",
    principalId: "legacy:unresolved",
    agentId: "main",
    workspaceId: "workspace",
    visibility: "private",
    retention: "durable",
  });
  db.prepare(`INSERT INTO memory_revisions
    (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
    VALUES ('revision:existing','legacy:existing',1,'Existing truth','candidate','unverified',NULL,?)`).run(now);
  db.prepare(`INSERT INTO memory_items
    (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
     visibility,retention,workspace_id,project_id,conversation_id,thread_id,customer_id,task_id,
     lifecycle,verification,valid_until,created_at,updated_at)
    VALUES ('legacy:existing','revision:existing',1,'Existing truth','fact',?,'local','legacy:unresolved',
      'main','private','durable','workspace',NULL,NULL,NULL,NULL,NULL,'candidate','unverified',NULL,?,?)`)
    .run(address, now, now);
  db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)").run(
    "source:existing", "revision:existing", "legacy", "existing", now, JSON.stringify({ original: true }),
  );
  db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)").run(
    "acl:existing", "legacy:existing", "legacy:unresolved", "private", "{}", now,
  );
  db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)").run(
    "event:existing", "legacy:existing", "revision:existing", "remembered", "operator:test", "baseline", now,
  );
  db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)")
    .run("legacy:existing", "Existing truth", "existing metadata");
  db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run("legacy:existing", "Existing truth", "fact");
  db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)")
    .run("legacy:existing", "existing", "v1-lancedb-fallback", "fallback_verified", now);
  db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)")
    .run("legacy:existing", "no_legacy_relation_source", now);
  for (const projection of ["fts", "vector", "relations"]) {
    db.prepare("INSERT INTO projection_outbox VALUES (?,?,?,?,?,0,?,?,?,NULL)")
      .run(`outbox:${projection}`, "legacy:existing", "revision:existing", "upsert", projection, now, now, now);
  }
  db.close();
  await chmod(source, 0o600);
  await privateJson(baseline, {
    schemaVersion: 1,
    phase: "clawlore-post-assignment-candidate-plan",
    proposedRolloutId: "clawlore-v2-candidate-promotion-fixture-r2",
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    assignment: { rowsValidated: 1, invalidEvidenceRows: 0, unplannedEvidenceRows: 0 },
    source: {
      v1Rows: 1,
      v2Rows: 1,
      candidateRows: 1,
      activeRows: 0,
      archivedRows: 0,
      compatibilityRows: 1,
      pendingOutboxRows: 0,
      baselineV1Rows: 1,
      unmirroredV1Rows: 0,
      missingLegacyRowsForV2: 0,
      candidateBaselineUnchanged: true,
      sourceUnchangedDuringPlan: true,
    },
    candidatePromotionPlan: {
      planDigest: sha256("candidate-plan"),
      automaticPromotionRows: 0,
      authorizesLiveMutation: false,
      counts: { eligible_for_promotion: 0, hold_candidate: 1, quarantine: 0 },
    },
    decision: { eligibleRows: 0, lifecycleRolloutSelectable: false, automaticPromotionRows: 0 },
    authorizesLifecycleMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    liveMutation: {
      evidenceRowsChanged: 0,
      lifecycleRowsChanged: 0,
      verificationRowsChanged: 0,
      addressRowsChanged: 0,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  });
  const plan = await createLiveV1AppendDeltaPlanV1({
    sourcePath: source,
    baselineReceiptPath: baseline,
    proposedRolloutId: rolloutId,
    defaults: { tenantId: "local", agentId: "main", workspaceId: "workspace" },
    now: () => new Date("2026-07-12T15:01:00.000Z"),
  });
  await privateJson(planPath, plan);
  const snapshot = await inspectLegacySqliteSnapshotV2(source, "2026-07-12T15:03:00.000Z");
  await writeFile(snapshotArchive, Buffer.from("fixture encrypted archive"), { mode: 0o600 });
  await chmod(snapshotArchive, 0o600);
  await privateJson(snapshotReceipt, {
    schemaVersion: 1,
    phase: "clawlore-v2-live-encrypted-snapshot",
    createdAt: "2026-07-12T15:03:00.000Z",
    status: "pass",
    authorizesV2Writes: false,
    archiveSha256: sha256(await readFile(snapshotArchive)),
    sourceStableDuringBackup: true,
    restoreVerified: true,
    restoredPlaintextRemoved: true,
    snapshot: {
      schemaDigest: snapshot.schemaDigest,
      memoryTruthRows: snapshot.memoryTruth.rowCount,
      memoryTruthLogicalDigest: snapshot.memoryTruth.logicalDigest,
      integrity: "ok",
      foreignKeyViolations: 0,
    },
  });
  return {
    root, source, baseline, planPath, snapshotArchive, snapshotReceipt,
    rolloutId, plan,
  };
}

function execute(paths) {
  return executeLiveV1AppendDeltaV1({
    sourcePath: paths.source,
    baselineReceiptPath: paths.baseline,
    planPath: paths.planPath,
    snapshotArchivePath: paths.snapshotArchive,
    snapshotReceiptPath: paths.snapshotReceipt,
    rolloutId: paths.rolloutId,
    planDigest: paths.plan.proposed.planDigest,
    defaults: { tenantId: "local", agentId: "main", workspaceId: "workspace" },
    now: () => new Date("2026-07-12T15:04:00.000Z"),
  });
}

test("append-only V1 delta writes candidate truth and converged projections", async () => {
  const paths = await fixture();
  try {
    const beforeEvidence = new DatabaseSync(paths.source, { readOnly: true })
      .prepare("SELECT evidence_json FROM memory_sources WHERE source_id='source:existing'").get().evidence_json;
    const receipt = await execute(paths);
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.v2.deltaRows, 1);
    assert.equal(receipt.v2.beforeRows, 1);
    assert.equal(receipt.v2.afterRows, 2);
    assert.equal(receipt.v2.candidateRows, 2);
    assert.equal(receipt.projections.compatibilityRows, 2);
    assert.equal(receipt.projections.ftsRows, 2);
    assert.equal(receipt.projections.vectorRows, 2);
    assert.equal(receipt.projections.relationProjectionRows, 2);
    assert.equal(receipt.projections.newProcessedOutboxRows, 3);
    assert.equal(receipt.projections.pendingOutboxRows, 0);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    const delta = db.prepare("SELECT lifecycle,verification FROM memory_items WHERE item_id='legacy:delta'").get();
    assert.deepEqual({ ...delta }, { lifecycle: "candidate", verification: "unverified" });
    assert.equal(db.prepare("SELECT evidence_json FROM memory_sources WHERE source_id='source:existing'").get().evidence_json,
      beforeEvidence);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_fts_compat_v2 WHERE memory_fts_compat_v2 MATCH 'delta'")
      .get().n, 1);
    const rolloutColumns = db.prepare("PRAGMA table_info(clawlore_rollouts_v2)").all().map((row) => row.name);
    assert.equal(rolloutColumns.includes("control_sha256"), true);
    assert.equal(rolloutColumns.includes("approval_sha256"), false);
    db.close();
    await assert.rejects(() => execute(paths), /no longer matches|already|coverage/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("append-only delta apply rejects plan drift before mutation", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source);
    db.prepare("UPDATE memory_truth SET text='changed after planning' WHERE id='delta'").run();
    db.close();
    await assert.rejects(() => execute(paths), /drifted|snapshot|plan/);
    const check = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM memory_items").get().n, 1);
    check.close();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("append-only delta apply rejects a plan that permits lifecycle mutation", async () => {
  const paths = await fixture();
  try {
    const value = JSON.parse(await readFile(paths.planPath, "utf8"));
    value.authorizesLifecyclePromotion = true;
    await privateJson(paths.planPath, value);
    await assert.rejects(() => execute(paths), /invalid|bounded write contract/);
    const check = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM memory_items").get().n, 1);
    check.close();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
