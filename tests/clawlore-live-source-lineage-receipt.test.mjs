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
const { createLiveSourceLineageReceiptPlanV1 } =
  jiti("../src/v2/operator/live-source-lineage-receipt-plan.ts");
const { executeLiveSourceLineageReceiptApplyV1 } =
  jiti("../src/v2/operator/live-source-lineage-receipt-apply.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function privateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-lineage-apply-"));
  const source = join(root, "live.sqlite3");
  const remediation = join(root, "remediation.json");
  const planPath = join(root, "plan.json");
  const snapshotArchive = join(root, "fresh.clawlore2");
  const snapshotReceipt = join(root, "snapshot.json");
  const rolloutId = "clawlore-v2-source-lineage-fixture-r1";
  const rows = [
    { id: "reflection-a", classification: "reflection_summary", lane: "derived_system_evidence_review",
      actor: "operator:approved-rollout" },
    { id: "reflection-b", classification: "reflection_summary", lane: "derived_system_evidence_review",
      actor: "operator:bounded-delta-rollout" },
    { id: "manual", classification: "explicit_manual", lane: "manual_principal_assignment_review",
      actor: "operator:bounded-rollout" },
  ];
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(
      id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
      timestamp REAL NOT NULL,metadata TEXT NOT NULL,metadata_text TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,text,metadata_text);
    ${TRUTH_V2_SCHEMA_SQL}
    CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_fts_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_relation_projection_v2(item_id TEXT PRIMARY KEY);`);
  const now = "2026-07-13T14:00:00.000Z";
  for (const row of rows) {
    const itemId = `legacy:${row.id}`;
    const revisionId = `revision:${row.id}`;
    const address = {
      schemaVersion: 2,
      tenantId: "tenant",
      principalId: "legacy:unresolved",
      agentId: "main",
      visibility: "private",
      retention: "durable",
    };
    const metadata = { source: row.classification, source_session: `batch:${row.id}` };
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?)")
      .run(row.id, `memory ${row.id}`, "other", "agent:main", Date.parse(now), JSON.stringify(metadata), `meta ${row.id}`);
    db.prepare("INSERT INTO memory_fts VALUES (?,?,?)").run(row.id, `memory ${row.id}`, `meta ${row.id}`);
    db.prepare(`INSERT INTO memory_revisions
      (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
      VALUES (?,?,1,?,'candidate','unverified',NULL,?)`).run(revisionId, itemId, `memory ${row.id}`, now);
    db.prepare(`INSERT INTO memory_items
      (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
       visibility,retention,lifecycle,verification,created_at,updated_at)
      VALUES (?,?,1,?,'other',?,'tenant','legacy:unresolved','main','private','durable','candidate','unverified',?,?)`)
      .run(itemId, revisionId, `memory ${row.id}`, JSON.stringify(address), now, now);
    db.prepare(`INSERT INTO memory_sources
      (source_id,revision_id,source_type,external_id,observed_at,evidence_json) VALUES (?,?,?,?,?,?)`)
      .run(`source:${row.id}`, revisionId, "legacy", row.id, now,
        JSON.stringify({ classification: row.classification, rolloutId: "origin-rollout-1", original: true }));
    db.prepare(`INSERT INTO memory_events
      (event_id,item_id,revision_id,event_type,actor,reason,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(`event:${row.id}`, itemId, revisionId, "remembered", row.actor, "origin-rollout-1", now);
    for (const table of [
      "memory_fts_compat_v2", "memory_fts_v2", "memory_vector_projection_v2", "memory_relation_projection_v2",
    ]) db.prepare(`INSERT INTO ${table} VALUES (?)`).run(itemId);
  }
  db.close();
  await chmod(source, 0o600);

  const sourceState = {
    v1Rows: 3, v2Rows: 3, candidateRows: 3, activeRows: 0, archivedRows: 0,
    compatibilityRows: 3, currentFtsRows: 3, vectorRows: 3, relationRows: 3, pendingOutboxRows: 0,
  };
  const remediationRows = rows.map((row) => ({
    itemIdSha256: sha256(`legacy:${row.id}`),
    lane: row.lane,
    requiredActions: ["fixture"],
  }));
  const counts = {
    registry_private_assignment_review: 0, registry_conversation_assignment_review: 0,
    registry_other_boundary_review: 0, assigned_private_evidence_review: 0,
    assigned_conversation_evidence_review: 0, manual_principal_assignment_review: 1,
    derived_system_evidence_review: 2, known_source_evidence_review: 0,
    unresolved_session_review: 0, legacy_provenance_hold_review: 0,
    policy_quarantine_review: 0, conflicting_registry_quarantine: 0,
    legacy_agent_alias_quarantine: 0, opaque_reference_quarantine: 0,
    unknown_legacy_quarantine: 0,
  };
  const summary = {
    assignmentReviewRows: 1, evidenceReviewRows: 2, quarantineRows: 0,
    policyHoldRows: 3, policyQuarantineRows: 0, mutationReadyRows: 0,
  };
  const remediationCore = {
    baselinePhase: "clawlore-post-assignment-candidate-plan",
    baselinePromotionPlanDigest: sha256("baseline"),
    baselinePreviewSha256: sha256("baseline-file"),
    source: sourceState,
    counts,
    summary,
    rows: remediationRows,
  };
  await privateJson(remediation, {
    schemaVersion: 1,
    phase: "clawlore-candidate-evidence-remediation-plan",
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    automaticPromotionRows: 0,
    authorizesLifecycleMutation: false,
    requiresOperatorReview: true,
    ...remediationCore,
    planDigest: sha256(JSON.stringify(remediationCore)),
  });
  const plan = createLiveSourceLineageReceiptPlanV1({
    sourcePath: source,
    remediationPreviewPath: remediation,
    proposedRolloutId: rolloutId,
  });
  await privateJson(planPath, plan);
  const snapshot = await inspectLegacySqliteSnapshotV2(source, "2026-07-13T14:02:00.000Z");
  await writeFile(snapshotArchive, Buffer.from("fixture encrypted archive"), { mode: 0o600 });
  await chmod(snapshotArchive, 0o600);
  await privateJson(snapshotReceipt, {
    schemaVersion: 1,
    phase: "clawlore-v2-live-encrypted-snapshot",
    createdAt: "2026-07-13T14:02:00.000Z",
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
  return { root, source, remediation, planPath, snapshotArchive, snapshotReceipt, rolloutId, plan };
}

function execute(paths) {
  return executeLiveSourceLineageReceiptApplyV1({
    sourcePath: paths.source,
    remediationPreviewPath: paths.remediation,
    planPath: paths.planPath,
    snapshotArchivePath: paths.snapshotArchive,
    snapshotReceiptPath: paths.snapshotReceipt,
    rolloutId: paths.rolloutId,
    planDigest: paths.plan.planDigest,
    now: () => new Date("2026-07-13T14:03:00.000Z"),
  });
}

test("source-lineage apply writes only exact target receipts and preserves runtime state", async () => {
  const paths = await fixture();
  try {
    const receipt = await execute(paths);
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.evidence.rowsWritten, 2);
    assert.equal(receipt.evidence.reflectionSummaryRows, 2);
    assert.equal(receipt.evidence.nonTargetEvidenceRowsChanged, 0);
    assert.equal(receipt.canonical.lifecycleRowsChanged, 0);
    assert.equal(receipt.canonical.verificationRowsChanged, 0);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    const rows = db.prepare(`SELECT i.item_id,i.lifecycle,i.verification,s.evidence_json
      FROM memory_items i JOIN memory_sources s ON s.revision_id=i.current_revision_id ORDER BY i.item_id`).all();
    const assigned = rows.filter((row) => JSON.parse(row.evidence_json).sourceLineageReceiptV1);
    assert.deepEqual(assigned.map((row) => row.item_id), ["legacy:reflection-a", "legacy:reflection-b"]);
    assert.equal(assigned.every((row) => {
      const lineage = JSON.parse(row.evidence_json).sourceLineageReceiptV1;
      return lineage.supportsSourceLineageOnly === true
        && lineage.authorizesLifecycleChange === false
        && lineage.authorizesVerificationChange === false;
    }), true);
    assert.equal(rows.every((row) => row.lifecycle === "candidate" && row.verification === "unverified"), true);
    assert.equal(JSON.parse(rows.find((row) => row.item_id === "legacy:manual").evidence_json).original, true);
    db.close();
    await assert.rejects(() => execute(paths), /no longer matches|already exists|already has a receipt/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("source-lineage apply rejects event drift before any evidence write", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source);
    db.prepare("UPDATE memory_events SET reason='drifted-rollout' WHERE event_id='event:reflection-a'").run();
    db.close();
    await assert.rejects(() => execute(paths), /no longer matches|target coverage/);
    const check = new DatabaseSync(paths.source, { readOnly: true });
    const evidence = check.prepare("SELECT evidence_json FROM memory_sources").all();
    assert.equal(evidence.some((row) => JSON.parse(row.evidence_json).sourceLineageReceiptV1), false);
    check.close();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
