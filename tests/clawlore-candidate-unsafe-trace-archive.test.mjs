import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { normalizeCandidateContentV1 } =
  jiti("../src/v2/application/candidate-content-quality-review.ts");
const {
  validateLiveCandidateUnsafeTraceDispositionPlanV1,
} = jiti("../src/v2/operator/live-candidate-unsafe-trace-disposition.ts");
const {
  acceptLiveCandidateUnsafeTraceArchiveV1,
  executeLiveCandidateUnsafeTraceArchiveV1,
  inspectLiveCandidateUnsafeTraceArchiveV1,
} = jiti("../src/v2/operator/live-candidate-unsafe-trace-archive.ts");
const { createLivePostUnsafeTraceArchiveCandidatePlanV1 } =
  jiti("../src/v2/operator/live-post-unsafe-trace-archive-candidate-plan.ts");
const { inspectLegacySqliteSnapshotV2 } =
  jiti("../src/v2/operator/legacy-v1-snapshot.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const now = "2026-07-14T01:00:00.000Z";
const TARGET_ROWS = 99;
const REWRITE_ROWS = 32;

function lineageReceipt(seed) {
  return {
    schemaVersion: 1,
    evidenceKind: "source-lineage-receipt",
    supportsSourceLineageOnly: true,
    authorizesLifecycleChange: false,
    authorizesVerificationChange: false,
    classification: "reflection_summary",
    sourceEvidenceDigest: sha256(`source:${seed}`),
    eventEvidenceDigest: sha256(`event:${seed}`),
    rolloutId: "lineage-rollout-r1",
    planDigest: sha256("lineage-plan"),
    proposedReceiptPayloadDigest: sha256("lineage-payload"),
    recordedAt: now,
    preservesLifecycle: true,
    preservesVerification: true,
  };
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function sourceState() {
  return {
    v1Rows: TARGET_ROWS + REWRITE_ROWS + 1,
    v2Rows: TARGET_ROWS + REWRITE_ROWS + 1,
    candidateRows: TARGET_ROWS + REWRITE_ROWS + 1,
    activeRows: 0,
    archivedRows: 0,
    compatibilityRows: TARGET_ROWS + REWRITE_ROWS + 1,
    currentFtsRows: TARGET_ROWS + REWRITE_ROWS + 1,
    vectorRows: TARGET_ROWS + REWRITE_ROWS + 1,
    relationRows: TARGET_ROWS + REWRITE_ROWS + 1,
    pendingOutboxRows: 0,
  };
}

function candidateBaseline(itemIdSha256) {
  const rows = itemIdSha256.sort().map((digest) => ({
    itemIdSha256: digest,
    disposition: "hold_candidate",
    reasonCodes: ["operator_review_required"],
  }));
  return {
    schemaVersion: 1,
    phase: "clawlore-post-assignment-candidate-plan",
    createdAt: now,
    proposedRolloutId: "candidate-baseline-before-unsafe-archive-r1",
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    assignment: {},
    source: {
      ...sourceState(),
      baselineV1Rows: TARGET_ROWS + REWRITE_ROWS + 1,
      unmirroredV1Rows: 0,
      missingLegacyRowsForV2: 0,
      candidateBaselineUnchanged: true,
      sourceUnchangedDuringPlan: true,
    },
    candidatePromotionPlan: {
      schemaVersion: 1,
      phase: "clawlore-candidate-promotion-review-plan",
      readOnly: true,
      emitsItemIds: false,
      authorizesLiveMutation: false,
      automaticPromotionRows: 0,
      counts: {
        eligible_for_promotion: 0,
        hold_candidate: rows.length,
        quarantine: 0,
        preserve_archived: 0,
      },
      rows,
      planDigest: sha256(JSON.stringify(rows)),
    },
    decision: {
      eligibleRows: 0,
      lifecycleRolloutSelectable: false,
      finalRecallCutoverBlockedByUnmirroredV1: false,
      automaticPromotionRows: 0,
    },
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

function insertCandidate(db, seed, content) {
  const itemId = `legacy:${seed}`;
  const revisionId = `revision:${seed}:1`;
  const address = JSON.stringify({ tenantId: "local", principalId: "joy", agentId: "main",
    visibility: "private", retention: "durable", workspaceId: "test" });
  const lineage = lineageReceipt(seed);
  db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)")
    .run(seed, content, "fact", "private", Number(seed.replace(/\D/g, "") || 0) + 1,
      JSON.stringify({ source: "reflection-summary" }));
  db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(itemId, revisionId, 1, content, "fact", address, "local", "joy", "main",
      "private", "durable", "test", null, null, null, null, null, "candidate", "unverified", null, now, now);
  db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
    .run(revisionId, itemId, 1, content, "candidate", "unverified", null, now);
  db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)")
    .run(`source:${seed}`, revisionId, "legacy", seed, now,
      JSON.stringify({ classification: "reflection_summary", sourceLineageReceiptV1: lineage }));
  db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)").run(`acl:${seed}`, itemId, "joy", "private", "{}", now);
  db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)")
    .run(`event:${seed}`, itemId, revisionId, "remembered", "fixture", "fixture", now);
  db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)").run(itemId, content, "{}");
  db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, content, "fact");
  db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)").run(itemId, seed, "fixture", "verified", now);
  db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)").run(itemId, "none", now);
  return { itemId, revisionId, lineage };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-unsafe-trace-archive-"));
  const source = join(root, "live.sqlite3");
  const planPath = join(root, "disposition-plan.json");
  const baselinePath = join(root, "candidate-baseline.json");
  const db = new DatabaseSync(source);
  createSchema(db);
  const archiveRows = [];
  const rewriteDesigns = [];
  for (let index = 0; index < TARGET_ROWS; index += 1) {
    const seed = `archive-${index}`;
    const content = `request ${index}\nCommand hints:\nrg transient-${index}\nFiles:\nfixture.log`;
    const inserted = insertCandidate(db, seed, content);
    archiveRows.push({
      itemIdSha256: sha256(inserted.itemId),
      currentRevisionIdSha256: sha256(inserted.revisionId),
      contentDigest: sha256(content),
      normalizedContentDigest: sha256(normalizeCandidateContentV1(content)),
      sourceLineageReceiptDigest: sha256(JSON.stringify(inserted.lineage)),
      category: "fact",
      captureSafetyPattern: "command-hints-block",
      captureSafetyLane: "command_trace_rejection_review",
      reason: index % 2 === 0 ? "pure_operational_trace" : "transient_runtime_state",
      resultDigest: sha256(`result:${seed}`),
      proposedAction: "soft_archive_under_separate_exact_apply",
      mutationReady: false,
      proposedLifecycle: "archived",
      proposedVerification: "unverified",
    });
  }
  for (let index = 0; index < REWRITE_ROWS; index += 1) {
    const seed = `rewrite-${index}`;
    const oversized = index < 7;
    const content = `request ${index}\nCommand hints:\nread trace\nResult:\n${oversized ? "x".repeat(4100) : `durable result ${index}`}`;
    const inserted = insertCandidate(db, seed, content);
    rewriteDesigns.push({
      itemIdSha256: sha256(inserted.itemId),
      currentRevisionIdSha256: sha256(inserted.revisionId),
      contentDigest: sha256(content),
      normalizedContentDigest: sha256(normalizeCandidateContentV1(content)),
      sourceLineageReceiptDigest: sha256(JSON.stringify(inserted.lineage)),
      category: "fact",
      captureSafetyPattern: "command-hints-block",
      captureSafetyLane: oversized ? "oversized_operational_trace_rewrite_review" : "command_trace_rejection_review",
      reason: oversized ? "oversized_trace_requires_segmentation" : "semantic_result_requires_rewrite_review",
      resultDigest: sha256(`result:${seed}`),
      rewriteDesign: oversized ? "segment_oversized_result" : "extract_durable_result",
      maximumProposedRows: oversized ? 4 : 1,
      removeCommandAndToolEnvelope: true,
      requireCaptureSafetyPass: true,
      requireCorpusDeduplication: true,
      proposedAction: "hold_for_separate_bounded_rewrite_proposal",
      mutationReady: false,
      proposedLifecycle: "candidate",
      proposedVerification: "unverified",
    });
  }
  const nonTarget = insertCandidate(db, "preserved-candidate", "A bounded candidate that must remain untouched.");
  db.close();
  await chmod(source, 0o600);
  archiveRows.sort((a, b) => a.itemIdSha256.localeCompare(b.itemIdSha256));
  rewriteDesigns.sort((a, b) => a.itemIdSha256.localeCompare(b.itemIdSha256));
  const summary = {
    targetRows: TARGET_ROWS + REWRITE_ROWS,
    softArchiveRows: TARGET_ROWS,
    boundedRewriteRows: REWRITE_ROWS,
    oversizedSegmentationRows: 7,
    semanticExtractionRows: 25,
    mutationReadyRows: 0,
    liveBindingMismatches: 0,
  };
  const core = {
    proposedDispositionId: "unsafe-trace-disposition-r1",
    adjudicationPlanDigest: sha256("adjudication-plan"),
    adjudicationPlanSha256: sha256("adjudication-file"),
    source: sourceState(),
    summary,
    archiveRows,
    rewriteDesigns,
  };
  const plan = {
    schemaVersion: 1,
    phase: "clawlore-candidate-unsafe-trace-disposition-plan",
    createdAt: now,
    proposedDispositionId: core.proposedDispositionId,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    emitsContentDigests: true,
    softArchiveProposalRows: TARGET_ROWS,
    boundedRewriteDesignRows: REWRITE_ROWS,
    mutationReadyRows: 0,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    requiresFreshEncryptedSnapshot: true,
    requiresSeparateExactApply: true,
    ...core,
    planDigest: sha256(JSON.stringify(core)),
  };
  await writePrivateJson(planPath, plan);
  await writePrivateJson(baselinePath, candidateBaseline([
    ...archiveRows.map((row) => row.itemIdSha256),
    ...rewriteDesigns.map((row) => row.itemIdSha256),
    sha256(nonTarget.itemId),
  ]));
  return { root, source, planPath, baselinePath, plan, nonTargetItem: nonTarget.itemId };
}

async function acceptedFixture() {
  const paths = await fixture();
  const acceptancePath = join(paths.root, "acceptance.json");
  const acceptance = acceptLiveCandidateUnsafeTraceArchiveV1({
    sourcePath: paths.source,
    planPath: paths.planPath,
    planDigest: paths.plan.planDigest,
    now: () => new Date("2026-07-14T01:01:00.000Z"),
  });
  await writePrivateJson(acceptancePath, acceptance);
  return { ...paths, acceptancePath, acceptance };
}

async function applyFixture() {
  const paths = await acceptedFixture();
  const archivePath = join(paths.root, "fresh.clawlore2");
  const snapshotReceiptPath = join(paths.root, "fresh.receipt.json");
  const archive = Buffer.from("fixture encrypted snapshot");
  await writeFile(archivePath, archive, { mode: 0o600 });
  await chmod(archivePath, 0o600);
  const legacy = await inspectLegacySqliteSnapshotV2(paths.source);
  await writePrivateJson(snapshotReceiptPath, {
    schemaVersion: 1,
    phase: "clawlore-v2-live-encrypted-snapshot",
    createdAt: "2026-07-14T01:02:00.000Z",
    status: "pass",
    authorizesV2Writes: false,
    archiveSha256: sha256(archive),
    sourceStableDuringBackup: true,
    restoreVerified: true,
    restoredPlaintextRemoved: true,
    snapshot: {
      schemaDigest: legacy.schemaDigest,
      memoryTruthRows: legacy.memoryTruth.rowCount,
      memoryTruthLogicalDigest: legacy.memoryTruth.logicalDigest,
      integrity: "ok",
      foreignKeyViolations: 0,
    },
  });
  return { ...paths, archivePath, snapshotReceiptPath };
}

test("unsafe trace archive acceptance binds exactly 99 archive rows and protects 32 rewrite holds", async () => {
  const paths = await acceptedFixture();
  try {
    assert.equal(paths.acceptance.summary.archiveRows, 99);
    assert.equal(paths.acceptance.summary.protectedRewriteRows, 32);
    assert.equal(paths.acceptance.summary.targetOverlapRows, 0);
    assert.equal(paths.acceptance.authorizesContentRewrite, false);
    assert.equal(paths.acceptance.requiresFreshEncryptedSnapshot, true);
    assert.equal(JSON.stringify(paths.acceptance).includes("Command hints:"), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("unsafe trace archive applies exactly 99 rows and preserves rewrite holds and non-targets", async () => {
  const paths = await applyFixture();
  try {
    const receipt = await executeLiveCandidateUnsafeTraceArchiveV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      acceptancePath: paths.acceptancePath,
      snapshotArchivePath: paths.archivePath,
      snapshotReceiptPath: paths.snapshotReceiptPath,
      rolloutId: "unsafe-trace-soft-archive-apply-r1",
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-14T01:03:00.000Z"),
    });
    assert.equal(receipt.sourceAfter.candidateRows, 33);
    assert.equal(receipt.sourceAfter.archivedRows, 99);
    assert.equal(receipt.archive.protectedRewriteRowsChanged, 0);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_items WHERE lifecycle='archived'").get().rows, 99);
    assert.equal(db.prepare("SELECT lifecycle FROM memory_items WHERE item_id=?").get(paths.nonTargetItem).lifecycle, "candidate");
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_fts_v2").get().rows, 132);
    db.close();
    const applyReceiptPath = join(paths.root, "apply.json");
    await writePrivateJson(applyReceiptPath, receipt);
    const postcheck = inspectLiveCandidateUnsafeTraceArchiveV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      applyReceiptPath,
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-14T01:04:00.000Z"),
    });
    assert.equal(postcheck.targetBinding.archivedRows, 99);
    assert.equal(postcheck.targetBinding.protectedRewriteRows, 32);
    assert.equal(postcheck.targetBinding.validDispositionReceiptRows, 99);
    assert.equal(postcheck.targetBinding.mismatches, 0);
    const postcheckPath = join(paths.root, "postcheck.json");
    await writePrivateJson(postcheckPath, postcheck);
    const rebased = createLivePostUnsafeTraceArchiveCandidatePlanV1({
      sourcePath: paths.source,
      priorBaselinePath: paths.baselinePath,
      archivePlanPath: paths.planPath,
      applyReceiptPath,
      postcheckPath,
      planDigest: paths.plan.planDigest,
      proposedRolloutId: "candidate-baseline-after-unsafe-archive-r1",
      now: () => new Date("2026-07-14T01:05:00.000Z"),
    });
    assert.equal(rebased.candidatePromotionPlan.counts.hold_candidate, 33);
    assert.equal(rebased.unsafeTraceArchiveRebase.archivedCandidateRows, 99);
    assert.equal(rebased.unsafeTraceArchiveRebase.protectedRewriteRows, 32);
    assert.equal(rebased.unsafeTraceArchiveRebase.preservedCandidateRows, 33);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("unsafe trace archive rejects stale snapshots before writes", async () => {
  const paths = await applyFixture();
  try {
    await assert.rejects(executeLiveCandidateUnsafeTraceArchiveV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      acceptancePath: paths.acceptancePath,
      snapshotArchivePath: paths.archivePath,
      snapshotReceiptPath: paths.snapshotReceiptPath,
      rolloutId: "unsafe-trace-soft-archive-apply-r1",
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-14T03:03:00.000Z"),
    }), /snapshot is invalid, stale/);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_items WHERE lifecycle='archived'").get().rows, 0);
    db.close();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("unsafe trace archive rejects plan tamper and rewrite-hold drift", async () => {
  const paths = await fixture();
  try {
    const tampered = structuredClone(paths.plan);
    tampered.archiveRows[0].reason = "semantic_result_requires_rewrite_review";
    assert.throws(() => validateLiveCandidateUnsafeTraceDispositionPlanV1(tampered, paths.plan.planDigest), /digest is invalid/);
    const rewrite = paths.plan.rewriteDesigns[0];
    const db = new DatabaseSync(paths.source);
    const row = db.prepare("SELECT item_id FROM memory_items").all()
      .find((entry) => sha256(entry.item_id) === rewrite.itemIdSha256);
    db.prepare("UPDATE memory_items SET content=content || ' drift' WHERE item_id=?").run(row.item_id);
    db.close();
    assert.throws(() => acceptLiveCandidateUnsafeTraceArchiveV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      planDigest: paths.plan.planDigest,
    }), /live target no longer matches/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
