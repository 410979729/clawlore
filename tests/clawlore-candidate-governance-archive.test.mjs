import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createAppendedCandidateArchiveDecisionControlV1,
} = jiti("../src/v2/operator/appended-candidate-archive-decisions.ts");
const {
  acceptLiveCandidateGovernanceArchivePlanV1,
  createLiveCandidateGovernanceArchivePlanV1,
} = jiti("../src/v2/operator/live-candidate-governance-archive-plan.ts");
const {
  executeLiveCandidateGovernanceArchiveV1,
  inspectLiveCandidateGovernanceArchiveV1,
} = jiti("../src/v2/operator/live-candidate-governance-archive-apply.ts");
const { inspectLegacySqliteSnapshotV2 } = jiti("../src/v2/operator/legacy-v1-snapshot.ts");
const { normalizeCandidateContentV1 } = jiti("../src/v2/application/candidate-content-quality-review.ts");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function privateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function sourceState(rows) {
  return {
    v1Rows: rows,
    v2Rows: rows,
    candidateRows: rows,
    activeRows: 0,
    archivedRows: 0,
    compatibilityRows: rows,
    currentFtsRows: rows,
    vectorRows: rows,
    relationRows: rows,
    pendingOutboxRows: 0,
  };
}

function createSchema(db) {
  db.exec(`CREATE TABLE memory_truth(id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,
      scope TEXT NOT NULL,timestamp INTEGER NOT NULL,metadata TEXT NOT NULL);
    CREATE TABLE memory_items(item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,
      revision_no INTEGER NOT NULL,content TEXT NOT NULL,category TEXT NOT NULL,address_json TEXT NOT NULL,
      tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,agent_id TEXT NOT NULL,visibility TEXT NOT NULL,
      retention TEXT NOT NULL,workspace_id TEXT,project_id TEXT,conversation_id TEXT,thread_id TEXT,
      customer_id TEXT,task_id TEXT,lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE memory_revisions(revision_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
      content TEXT NOT NULL,lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,created_at TEXT NOT NULL);
    CREATE TABLE memory_sources(source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,source_type TEXT NOT NULL,
      external_id TEXT,observed_at TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE TABLE memory_relations(relation_id TEXT PRIMARY KEY,from_revision_id TEXT NOT NULL,to_revision_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memory_acl(acl_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,
      visibility TEXT NOT NULL,policy_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memory_events(event_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_id TEXT,event_type TEXT NOT NULL,
      actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY,content TEXT NOT NULL,metadata_text TEXT NOT NULL);
    CREATE TABLE memory_fts_v2(item_id TEXT PRIMARY KEY,content TEXT NOT NULL,category TEXT NOT NULL);
    CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY,legacy_id TEXT,backend TEXT,state TEXT,verified_at TEXT);
    CREATE TABLE memory_relation_projection_v2(item_id TEXT PRIMARY KEY,state TEXT,verified_at TEXT);
    CREATE TABLE projection_outbox(outbox_id TEXT PRIMARY KEY,item_id TEXT,revision_id TEXT,operation TEXT,projection TEXT,
      attempts INTEGER,available_at TEXT,created_at TEXT,processed_at TEXT,last_error TEXT);
    CREATE TABLE clawlore_rollouts_v2(rollout_id TEXT PRIMARY KEY,plan_digest TEXT NOT NULL,control_sha256 TEXT NOT NULL,
      readiness_sha256 TEXT NOT NULL,legacy_logical_digest TEXT NOT NULL,rows_applied INTEGER NOT NULL,
      applied_at TEXT NOT NULL,v1_fallback_reads INTEGER NOT NULL,context_engine_enabled INTEGER NOT NULL,
      final_recall_cutover_enabled INTEGER NOT NULL);`);
}

function seedCandidate(db, sequence, input) {
  const id = `row-${sequence}`;
  const itemId = `legacy:${id}`;
  const revisionId = `revision:${id}:1`;
  const now = "2026-07-22T00:00:00.000Z";
  const address = JSON.stringify({ tenantId: "local", principalId: "joy", agentId: "main", visibility: "private" });
  const evidence = {
    classification: input.classification,
    reviewRequired: true,
    rolloutId: input.appended ? "clawlore-test-v1-append-r1" : "clawlore-test-prior-r1",
    verificationDebt: true,
    ...(input.appended ? { appendOnlyV1Delta: true } : {}),
  };
  db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)")
    .run(id, input.content, input.category, "private", sequence, JSON.stringify({ source: input.classification }));
  db.prepare(`INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    itemId, revisionId, 1, input.content, input.category, address,
    "local", "joy", "main", "private", "durable", "test", null, null, null, null, null,
    "candidate", "unverified", null, now, now,
  );
  db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
    .run(revisionId, itemId, 1, input.content, "candidate", "unverified", null, now);
  db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)")
    .run(`source:${id}:1`, revisionId, input.classification, null, now, JSON.stringify(evidence));
  db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)")
    .run(`acl:${id}`, itemId, "joy", "private", "{}", now);
  db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)").run(itemId, input.content, "");
  db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, input.content, input.category);
  db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)")
    .run(itemId, id, "lancedb", "verified", now);
  db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)").run(itemId, "verified", now);
  return { itemId, revisionId, content: input.content, category: input.category };
}

function priorPlan(rows) {
  const source = sourceState(24);
  const plannedRows = rows.map((row, index) => ({
    itemIdSha256: sha256(row.itemId),
    currentRevisionIdSha256: sha256(row.revisionId),
    contentDigest: sha256(row.content),
    normalizedContentDigest: sha256(normalizeCandidateContentV1(row.content)),
    sourceLineageReceiptDigest: sha256(`lineage:${index}`),
    category: row.category,
    sourceLane: "manual_semantic_review",
    disposition: "propose_soft_archive",
    basis: ["covered_by_canonical_policy", "semantic_redundancy", "transient_conversation", "volatile_runtime_snapshot"][index % 4],
    evidenceDigest: sha256(`evidence:${index}`),
    proposedNextAction: "soft_archive_under_separate_exact_apply",
    mutationReady: false,
    proposedLifecycle: "candidate",
    proposedVerification: "unverified",
  }));
  const core = {
    proposedAdjudicationId: "clawlore-test-prior-adjudication-r1",
    contentQualityPlanDigest: sha256("content-quality"),
    contentQualityPreviewSha256: sha256("content-preview"),
    rewritePlanDigest: sha256("rewrite-plan"),
    rewritePlanSha256: sha256("rewrite-file"),
    rewriteApplyReceiptSha256: sha256("rewrite-apply"),
    rewritePostcheckSha256: sha256("rewrite-postcheck"),
    decisionControlDigest: sha256("decision-control"),
    decisionControlSha256: sha256("decision-file"),
    source,
    rewriteClosure: { rewrittenRows: 32, validRewriteReceiptRows: 32, closedFromSemanticReviewRows: 32, mismatches: 0 },
    summary: { targetRows: 24, proposedSoftArchiveRows: 24, mutationReadyRows: 0 },
    rows: plannedRows,
  };
  return {
    schemaVersion: 1,
    phase: "clawlore-candidate-post-rewrite-adjudication-plan",
    createdAt: "2026-07-22T00:00:00.000Z",
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    emitsContentDigests: true,
    mutationReadyRows: 0,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    requiresSeparateExactApply: true,
    ...core,
    planDigest: sha256(JSON.stringify(core)),
  };
}

test("governance archive binds, preserves, postchecks, and replays exactly 112 rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-governance-archive-"));
  try {
    const source = join(root, "memory.sqlite3");
    const priorPath = join(root, "prior.json");
    const decisionsPath = join(root, "decisions.json");
    const planPath = join(root, "plan.json");
    const acceptancePath = join(root, "acceptance.json");
    const archivePath = join(root, "snapshot.clawlore2");
    const snapshotReceiptPath = join(root, "snapshot.receipt.json");
    const applyPath = join(root, "apply.json");
    const db = new DatabaseSync(source);
    createSchema(db);
    const priorRows = [];
    for (let index = 0; index < 24; index += 1) {
      priorRows.push(seedCandidate(db, index, {
        appended: false,
        classification: "reflection_summary",
        category: index % 2 ? "fact" : "decision",
        content: `Prior transient candidate ${index}`,
      }));
    }
    const manualContent = "Obsolete cross-instance sharing policy";
    const unknownContent = "reflection-event event trace";
    for (let index = 0; index < 88; index += 1) {
      const classification = index < 66 ? "reflection_summary"
        : index < 86 ? "operational_checkpoint"
          : index === 86 ? "explicit_manual" : "unknown_legacy";
      const content = classification === "explicit_manual" ? manualContent
        : classification === "unknown_legacy" ? unknownContent
          : `${classification} candidate ${index}`;
      seedCandidate(db, 24 + index, { appended: true, classification, category: "fact", content });
    }
    db.close();
    await privateJson(priorPath, priorPlan(priorRows));
    const decisions = createAppendedCandidateArchiveDecisionControlV1({
      sourcePath: source,
      decisionId: "clawlore-test-appended-decisions-r1",
      sourceRolloutId: "clawlore-test-v1-append-r1",
      explicitManualContentDigest: sha256(manualContent),
      unknownLegacyContentDigest: sha256(unknownContent),
    });
    assert.equal(decisions.rows.length, 88);
    await privateJson(decisionsPath, decisions);
    const plan = createLiveCandidateGovernanceArchivePlanV1({
      sourcePath: source,
      priorAdjudicationPath: priorPath,
      appendedDecisionPath: decisionsPath,
      proposedArchiveId: "clawlore-test-governance-archive-r1",
    });
    assert.equal(plan.rows.length, 112);
    await privateJson(planPath, plan);

    const driftDb = new DatabaseSync(source);
    driftDb.prepare("UPDATE memory_items SET principal_id='drifted' WHERE item_id=?").run(priorRows[0].itemId);
    driftDb.close();
    assert.throws(() => acceptLiveCandidateGovernanceArchivePlanV1({
      sourcePath: source, planPath, planDigest: plan.planDigest,
    }), /no longer matches/);
    const restoreDb = new DatabaseSync(source);
    restoreDb.prepare("UPDATE memory_items SET principal_id='joy' WHERE item_id=?").run(priorRows[0].itemId);
    restoreDb.close();

    const acceptance = acceptLiveCandidateGovernanceArchivePlanV1({
      sourcePath: source, planPath, planDigest: plan.planDigest,
    });
    await privateJson(acceptancePath, acceptance);
    const snapshot = await inspectLegacySqliteSnapshotV2(source);
    const archiveBytes = Buffer.from("test-encrypted-snapshot");
    await writeFile(archivePath, archiveBytes, { mode: 0o600 });
    await privateJson(snapshotReceiptPath, {
      schemaVersion: 1,
      phase: "clawlore-v2-live-encrypted-snapshot",
      createdAt: new Date().toISOString(),
      status: "pass",
      authorizesV2Writes: false,
      archiveSha256: sha256(archiveBytes),
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
    const applied = await executeLiveCandidateGovernanceArchiveV1({
      sourcePath: source,
      planPath,
      acceptancePath,
      snapshotArchivePath: archivePath,
      snapshotReceiptPath,
      rolloutId: "clawlore-test-governance-archive-apply-r1",
      planDigest: plan.planDigest,
    });
    assert.equal(applied.idempotentReplay, false);
    assert.equal(applied.archive.rowsChangedThisRun, 112);
    await privateJson(applyPath, applied);
    const postcheck = inspectLiveCandidateGovernanceArchiveV1({
      sourcePath: source, planPath, applyReceiptPath: applyPath, planDigest: plan.planDigest,
    });
    assert.equal(postcheck.status, "pass");
    assert.equal(postcheck.source.candidateRows, 0);
    assert.equal(postcheck.source.archivedRows, 112);
    const replay = await executeLiveCandidateGovernanceArchiveV1({
      sourcePath: source,
      planPath,
      acceptancePath,
      snapshotArchivePath: archivePath,
      snapshotReceiptPath,
      rolloutId: "clawlore-test-governance-archive-apply-r1",
      planDigest: plan.planDigest,
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.archive.rowsChangedThisRun, 0);
    const verify = new DatabaseSync(source, { readOnly: true });
    assert.equal(verify.prepare("SELECT COUNT(*) AS rows FROM memory_truth").get().rows, 112);
    assert.equal(verify.prepare("SELECT COUNT(*) AS rows FROM memory_items WHERE lifecycle='archived'").get().rows, 112);
    assert.equal(verify.prepare("SELECT COUNT(*) AS rows FROM memory_revisions WHERE lifecycle='superseded'").get().rows, 112);
    assert.equal(verify.prepare("SELECT COUNT(*) AS rows FROM memory_revisions WHERE lifecycle='archived'").get().rows, 112);
    assert.equal(verify.prepare("SELECT COUNT(*) AS rows FROM clawlore_rollouts_v2").get().rows, 1);
    verify.close();
    assert.ok((await readFile(applyPath, "utf8")).includes('"currentContentRowsChanged": 0'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
