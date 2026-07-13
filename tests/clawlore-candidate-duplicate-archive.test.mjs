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
  createLiveCandidateDuplicateArchivePlanV1,
  acceptLiveCandidateDuplicateArchivePlanV1,
  executeLiveCandidateDuplicateArchiveV1,
  inspectLiveCandidateDuplicateArchiveV1,
} = jiti("../src/v2/operator/live-candidate-duplicate-archive.ts");
const { createLivePostDuplicateArchiveCandidatePlanV1 } =
  jiti("../src/v2/operator/live-post-duplicate-archive-candidate-plan.ts");
const { createLivePostV1AppendCandidatePlanV1 } =
  jiti("../src/v2/operator/live-post-v1-append-candidate-plan.ts");
const { inspectLegacySqliteSnapshotV2 } =
  jiti("../src/v2/operator/legacy-v1-snapshot.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const now = "2026-07-13T13:00:00.000Z";
const groupSizes = [2, 2, 2, 4, 4];

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
    v1Rows: 15,
    v2Rows: 15,
    candidateRows: 15,
    activeRows: 0,
    archivedRows: 0,
    compatibilityRows: 15,
    currentFtsRows: 15,
    vectorRows: 15,
    relationRows: 15,
    pendingOutboxRows: 0,
  };
}

function candidateBaseline(rows) {
  const promotionRows = rows.map((row) => ({
    itemIdSha256: row.itemIdSha256,
    disposition: "hold_candidate",
    reasonCodes: ["operator_review_required"],
  })).sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
  return {
    schemaVersion: 1,
    phase: "clawlore-post-assignment-candidate-plan",
    createdAt: now,
    proposedRolloutId: "candidate-baseline-before-duplicate-archive-r1",
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    assignment: {},
    source: {
      ...sourceState(),
      baselineV1Rows: 15,
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
        hold_candidate: 15,
        quarantine: 0,
        preserve_archived: 0,
      },
      rows: promotionRows,
      planDigest: sha256(JSON.stringify(promotionRows)),
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-duplicate-archive-"));
  const source = join(root, "live.sqlite3");
  const adjudicationPath = join(root, "adjudication.json");
  const baselinePath = join(root, "baseline.json");
  const safetyPath = join(root, "safety.json");
  const db = new DatabaseSync(source);
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
  const address = JSON.stringify({ tenantId: "local", principalId: "joy", agentId: "main",
    visibility: "private", retention: "durable", workspaceId: "test" });
  const targetRows = [];
  const groups = [];
  const safetyRows = [];
  let sequence = 0;
  for (const [groupIndex, groupSize] of groupSizes.entries()) {
    const content = `Command hints:\n- transient duplicate group ${groupIndex}\nResult: already covered`;
    const normalizedContentDigest = sha256(normalizeCandidateContentV1(content));
    const basis = groupIndex % 2 === 0 ? "covered_by_existing_truth" : "transient_operational_trace";
    const evidenceDigest = sha256(`knowledge:${groupIndex}`);
    groups.push({
      normalizedContentDigest,
      expectedGroupSize: groupSize,
      disposition: "propose_soft_archive",
      basis,
      evidenceDigest,
    });
    for (let member = 0; member < groupSize; member += 1) {
      sequence += 1;
      const id = `duplicate-${groupIndex}-${member}`;
      const itemId = `legacy:${id}`;
      const revisionId = `revision:${id}:1`;
      const lineage = lineageReceipt(id);
      const row = {
        itemIdSha256: sha256(itemId),
        currentRevisionIdSha256: sha256(revisionId),
        contentDigest: sha256(content),
        normalizedContentDigest,
        sourceLineageReceiptDigest: sha256(JSON.stringify(lineage)),
        category: "fact",
        captureSafetyReason: "operational-trace",
        captureSafetyPattern: "command-hints-block",
        duplicateGroupSize: groupSize,
        oversized: false,
        disposition: "propose_soft_archive",
        basis,
        evidenceDigest,
        proposedNextAction: "soft_archive_under_separate_exact_apply",
        mutationReady: false,
        proposedLifecycle: "candidate",
        proposedVerification: "unverified",
      };
      targetRows.push(row);
      safetyRows.push({
        itemIdSha256: row.itemIdSha256,
        currentRevisionIdSha256: row.currentRevisionIdSha256,
        contentDigest: row.contentDigest,
        normalizedContentDigest: row.normalizedContentDigest,
        sourceLineageReceiptDigest: row.sourceLineageReceiptDigest,
        category: row.category,
        captureSafetyReason: row.captureSafetyReason,
        captureSafetyPattern: row.captureSafetyPattern,
        exactDuplicate: true,
        oversized: false,
        lane: "exact_duplicate_operational_trace_review",
        requiredActions: ["operator_decision_required"],
        proposedLifecycle: "candidate",
        proposedVerification: "unverified",
      });
      db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)")
        .run(id, content, "fact", "private", sequence, JSON.stringify({ source: "reflection-summary" }));
      db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(itemId, revisionId, 1, content, "fact", address, "local", "joy", "main",
          "private", "durable", "test", null, null, null, null, null, "candidate", "unverified", null, now, now);
      db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
        .run(revisionId, itemId, 1, content, "candidate", "unverified", null, now);
      db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)")
        .run(`source:${id}`, revisionId, "legacy", id, now,
          JSON.stringify({ classification: "reflection_summary", sourceLineageReceiptV1: lineage }));
      db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)").run(`acl:${id}`, itemId, "joy", "private", "{}", now);
      db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)")
        .run(`event:${id}`, itemId, revisionId, "remembered", "fixture", "fixture", now);
      db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)").run(itemId, content, "{}");
      db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, content, "fact");
      db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)").run(itemId, id, "fixture", "verified", now);
      db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)").run(itemId, "none", now);
    }
  }
  const nonTargetId = "preserved-candidate";
  const nonTargetItem = `legacy:${nonTargetId}`;
  const nonTargetRevision = `revision:${nonTargetId}:1`;
  const nonTargetContent = "A bounded candidate that must remain untouched.";
  const nonTargetLineage = lineageReceipt(nonTargetId);
  db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)")
    .run(nonTargetId, nonTargetContent, "fact", "private", 15, JSON.stringify({ source: "reflection-summary" }));
  db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(nonTargetItem, nonTargetRevision, 1, nonTargetContent, "fact", address, "local", "joy", "main",
      "private", "durable", "test", null, null, null, null, null, "candidate", "unverified", null, now, now);
  db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
    .run(nonTargetRevision, nonTargetItem, 1, nonTargetContent, "candidate", "unverified", null, now);
  db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)")
    .run(`source:${nonTargetId}`, nonTargetRevision, "legacy", nonTargetId, now,
      JSON.stringify({ classification: "reflection_summary", sourceLineageReceiptV1: nonTargetLineage }));
  db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)").run(`acl:${nonTargetId}`, nonTargetItem, "joy", "private", "{}", now);
  db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)")
    .run(`event:${nonTargetId}`, nonTargetItem, nonTargetRevision, "remembered", "fixture", "fixture", now);
  db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)").run(nonTargetItem, nonTargetContent, "{}");
  db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(nonTargetItem, nonTargetContent, "fact");
  db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)")
    .run(nonTargetItem, nonTargetId, "fixture", "verified", now);
  db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)").run(nonTargetItem, "none", now);
  db.close();
  await chmod(source, 0o600);

  const holdGroups = Array.from({ length: 3 }, (_, index) => ({
    normalizedContentDigest: sha256(`hold-group:${index}`),
    expectedGroupSize: 2,
    disposition: "hold_for_bounded_rewrite",
    basis: "durable_fact_requires_rewrite",
    evidenceDigest: sha256(`hold-evidence:${index}`),
  }));
  const holdRows = holdGroups.flatMap((group, groupIndex) => Array.from({ length: 2 }, (_, member) => ({
    itemIdSha256: sha256(`hold-item:${groupIndex}:${member}`),
    currentRevisionIdSha256: sha256(`hold-revision:${groupIndex}:${member}`),
    contentDigest: sha256(`hold-content:${groupIndex}`),
    normalizedContentDigest: group.normalizedContentDigest,
    sourceLineageReceiptDigest: sha256(`hold-lineage:${groupIndex}:${member}`),
    category: "decision",
    captureSafetyReason: "operational-trace",
    captureSafetyPattern: "command-hints-block",
    duplicateGroupSize: 2,
    oversized: false,
    disposition: "hold_for_bounded_rewrite",
    basis: "durable_fact_requires_rewrite",
    evidenceDigest: group.evidenceDigest,
    proposedNextAction: "bounded_rewrite_under_separate_exact_apply",
    mutationReady: false,
    proposedLifecycle: "candidate",
    proposedVerification: "unverified",
  })));
  const summary = {
    targetGroups: 8,
    targetRows: 20,
    softArchiveGroups: 5,
    softArchiveRows: 14,
    rewriteHoldGroups: 3,
    rewriteHoldRows: 6,
    mutationReadyRows: 0,
  };
  const adjudicationCore = {
    proposedAdjudicationId: "duplicate-adjudication-r1",
    captureSafetyPlanDigest: sha256("original-safety"),
    captureSafetyPreviewSha256: sha256("original-safety-file"),
    decisionControlDigest: sha256("decision-control"),
    decisionControlSha256: sha256("decision-control-file"),
    captureSafetySource: sourceState(),
    appendOnlySourceExtensionRows: 0,
    source: sourceState(),
    summary,
    groups: [...groups, ...holdGroups].sort((a, b) => a.normalizedContentDigest.localeCompare(b.normalizedContentDigest)),
    rows: [...targetRows, ...holdRows].sort((a, b) => a.itemIdSha256.localeCompare(b.itemIdSha256)),
  };
  await writePrivateJson(adjudicationPath, {
    schemaVersion: 1,
    phase: "clawlore-candidate-duplicate-trace-adjudication-plan",
    createdAt: now,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    proposesSoftArchiveRows: 14,
    holdsForBoundedRewriteRows: 6,
    mutationReadyRows: 0,
    authorizesRejectionMutation: false,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    requiresSeparateExactApply: true,
    ...adjudicationCore,
    planDigest: sha256(JSON.stringify(adjudicationCore)),
  });
  const allBaselineRows = [...targetRows, {
    itemIdSha256: sha256(nonTargetItem),
  }];
  await writePrivateJson(baselinePath, candidateBaseline(allBaselineRows));
  const safetyCore = {
    proposedReviewId: "post-companion-safety-r1",
    contentQualityPlanDigest: sha256("quality"),
    contentQualityPreviewSha256: sha256("quality-file"),
    source: sourceState(),
    counts: { exact_duplicate_operational_trace_review: 14 },
    summary: { targetRows: 14, exactDuplicateRows: 14, automaticArchiveRows: 0, mutationReadyRows: 0 },
    rows: safetyRows.sort((a, b) => a.itemIdSha256.localeCompare(b.itemIdSha256)),
  };
  await writePrivateJson(safetyPath, {
    schemaVersion: 1,
    phase: "clawlore-candidate-capture-safety-review-plan",
    createdAt: now,
    ...safetyCore,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    automaticArchiveRows: 0,
    authorizesRejectionMutation: false,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    requiresOperatorDecision: true,
    planDigest: sha256(JSON.stringify(safetyCore)),
  });
  return { root, source, adjudicationPath, baselinePath, safetyPath, targetRows, nonTargetItem };
}

async function plannedFixture() {
  const paths = await fixture();
  const planPath = join(paths.root, "archive-plan.json");
  const acceptancePath = join(paths.root, "archive-acceptance.json");
  const plan = createLiveCandidateDuplicateArchivePlanV1({
    sourcePath: paths.source,
    adjudicationPlanPath: paths.adjudicationPath,
    candidateBaselinePath: paths.baselinePath,
    captureSafetyPath: paths.safetyPath,
    proposedArchiveId: "duplicate-soft-archive-r1",
    now: () => new Date(now),
  });
  await writePrivateJson(planPath, plan);
  const acceptance = acceptLiveCandidateDuplicateArchivePlanV1({
    sourcePath: paths.source,
    planPath,
    planDigest: plan.planDigest,
    now: () => new Date("2026-07-13T13:01:00.000Z"),
  });
  await writePrivateJson(acceptancePath, acceptance);
  return { ...paths, plan, planPath, acceptancePath };
}

async function applyFixture() {
  const paths = await plannedFixture();
  const archivePath = join(paths.root, "fresh.clawlore2");
  const snapshotReceiptPath = join(paths.root, "fresh.receipt.json");
  const archive = Buffer.from("fixture encrypted snapshot");
  await writeFile(archivePath, archive, { mode: 0o600 });
  await chmod(archivePath, 0o600);
  const legacy = await inspectLegacySqliteSnapshotV2(paths.source);
  await writePrivateJson(snapshotReceiptPath, {
    schemaVersion: 1,
    phase: "clawlore-v2-live-encrypted-snapshot",
    createdAt: "2026-07-13T13:02:00.000Z",
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

test("duplicate archive planning binds exactly five groups and fourteen current hold candidates", async () => {
  const paths = await plannedFixture();
  try {
    assert.equal(paths.plan.summary.targetGroups, 5);
    assert.equal(paths.plan.summary.targetRows, 14);
    assert.equal(paths.plan.authorizesSoftArchive, false);
    assert.equal(paths.plan.requiresFreshEncryptedSnapshot, true);
    assert.equal(paths.plan.rows.length, 14);
    const serialized = JSON.stringify(paths.plan);
    assert.equal(serialized.includes("Command hints:"), false);
    assert.equal(serialized.includes("legacy:duplicate"), false);
    const acceptance = JSON.parse(await readFile(paths.acceptancePath, "utf8"));
    assert.equal(acceptance.status, "pass");
    assert.equal(acceptance.liveBindingMismatches, 0);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("exact duplicate archive soft-archives fourteen rows, preserves one non-target, and rebases candidates", async () => {
  const paths = await applyFixture();
  try {
    const receipt = await executeLiveCandidateDuplicateArchiveV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      acceptancePath: paths.acceptancePath,
      snapshotArchivePath: paths.archivePath,
      snapshotReceiptPath: paths.snapshotReceiptPath,
      rolloutId: "duplicate-soft-archive-apply-r1",
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-13T13:03:00.000Z"),
    });
    assert.equal(receipt.sourceAfter.candidateRows, 1);
    assert.equal(receipt.sourceAfter.archivedRows, 14);
    assert.equal(receipt.archive.candidateRowsArchived, 14);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_items WHERE lifecycle='archived'").get().rows, 14);
    assert.equal(db.prepare("SELECT lifecycle FROM memory_items WHERE item_id=?").get(paths.nonTargetItem).lifecycle, "candidate");
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_fts_v2").get().rows, 15);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM projection_outbox").get().rows, 0);
    db.close();
    const applyReceiptPath = join(paths.root, "apply.json");
    await writePrivateJson(applyReceiptPath, receipt);
    const postcheck = inspectLiveCandidateDuplicateArchiveV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      applyReceiptPath,
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-13T13:04:00.000Z"),
    });
    assert.equal(postcheck.targetBinding.archivedRows, 14);
    assert.equal(postcheck.targetBinding.archivedGroups, 5);
    assert.equal(postcheck.targetBinding.mismatches, 0);
    const postcheckPath = join(paths.root, "postcheck.json");
    await writePrivateJson(postcheckPath, postcheck);
    const rebased = createLivePostDuplicateArchiveCandidatePlanV1({
      sourcePath: paths.source,
      priorBaselinePath: paths.baselinePath,
      archivePlanPath: paths.planPath,
      applyReceiptPath,
      postcheckPath,
      planDigest: paths.plan.planDigest,
      proposedRolloutId: "candidate-baseline-after-duplicate-archive-r1",
      now: () => new Date("2026-07-13T13:05:00.000Z"),
    });
    assert.equal(rebased.source.candidateRows, 1);
    assert.equal(rebased.source.archivedRows, 14);
    assert.equal(rebased.candidatePromotionPlan.counts.hold_candidate, 1);
    assert.equal(rebased.duplicateArchiveRebase.archivedCandidateRows, 14);
    assert.equal(rebased.duplicateArchiveRebase.removedItemIdSha256.length, 14);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("duplicate archive rejects stale snapshots and target drift before writes", async () => {
  const stale = await applyFixture();
  try {
    await assert.rejects(executeLiveCandidateDuplicateArchiveV1({
      sourcePath: stale.source,
      planPath: stale.planPath,
      acceptancePath: stale.acceptancePath,
      snapshotArchivePath: stale.archivePath,
      snapshotReceiptPath: stale.snapshotReceiptPath,
      rolloutId: "duplicate-soft-archive-apply-r1",
      planDigest: stale.plan.planDigest,
      now: () => new Date("2026-07-13T15:03:00.000Z"),
    }), /snapshot is invalid, stale/);
    const db = new DatabaseSync(stale.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_items WHERE lifecycle='archived'").get().rows, 0);
    db.close();
  } finally {
    await rm(stale.root, { recursive: true, force: true });
  }
  const drifted = await plannedFixture();
  try {
    const db = new DatabaseSync(drifted.source);
    db.prepare("UPDATE memory_items SET content=content || ' drift' WHERE item_id=?")
      .run(`legacy:duplicate-0-0`);
    db.close();
    assert.throws(() => acceptLiveCandidateDuplicateArchivePlanV1({
      sourcePath: drifted.source,
      planPath: drifted.planPath,
      planDigest: drifted.plan.planDigest,
    }), /live target no longer matches/);
  } finally {
    await rm(drifted.root, { recursive: true, force: true });
  }
});

test("post-append candidate rebase adds only one conservative operational checkpoint hold", async () => {
  const paths = await fixture();
  try {
    const baseline = JSON.parse(await readFile(paths.baselinePath, "utf8"));
    const baselineSha256 = sha256(await readFile(paths.baselinePath));
    const itemId = "legacy:append-checkpoint";
    const revisionId = "revision:append-checkpoint:1";
    const address = JSON.stringify({ tenantId: "legacy", principalId: "legacy:unresolved",
      agentId: "legacy", visibility: "private", retention: "durable" });
    const evidence = JSON.stringify({ classification: "operational_checkpoint",
      verificationDebt: "legacy_identity", reviewRequired: true });
    const db = new DatabaseSync(paths.source);
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)")
      .run("append-checkpoint", "bounded checkpoint", "fact", "private", 16,
        JSON.stringify({ source: "checkpoint" }));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(itemId, revisionId, 1, "bounded checkpoint", "fact", address, "legacy",
        "legacy:unresolved", "legacy", "private", "durable", null, null, null, null,
        null, null, "candidate", "unverified", null, now, now);
    db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
      .run(revisionId, itemId, 1, "bounded checkpoint", "candidate", "unverified", null, now);
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)")
      .run("source:append-checkpoint", revisionId, "legacy", "append-checkpoint", now, evidence);
    db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)")
      .run("acl:append-checkpoint", itemId, "legacy:unresolved", "private", "{}", now);
    db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)")
      .run("event:append-checkpoint", itemId, revisionId, "remembered", "fixture", "fixture", now);
    db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)").run(itemId, "bounded checkpoint", "{}");
    db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, "bounded checkpoint", "fact");
    db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)")
      .run(itemId, "append-checkpoint", "fixture", "verified", now);
    db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)").run(itemId, "none", now);
    db.close();
    const planDigest = sha256("append-plan-r1");
    const planPath = join(paths.root, "append-plan.json");
    const plan = {
      schemaVersion: 1, phase: "clawlore-v1-append-delta-plan", createdAt: now,
      proposedRolloutId: "append-rollout-r1", readOnly: true, queryOnly: true,
      emitsMemoryContent: false, emitsRawIdentifiers: false,
      baseline: { receiptSha256: baselineSha256,
        candidatePlanDigest: baseline.candidatePromotionPlan.planDigest, candidateRows: 15,
        candidateBaselineUnchanged: true },
      source: { v1Rows: 16, v2Rows: 15, deltaRows: 1, missingLegacyRowsForV2: 0,
        compatibilityRows: 15, pendingOutboxRows: 0, memoryTruthLogicalDigest: sha256("truth"),
        sourceUnchangedDuringPlan: true },
      proposed: { activeRows: 0, candidateRows: 1, archivedRows: 0,
        classifications: { operational_checkpoint: 1 }, verifications: { unverified: 1 },
        verificationDebt: { legacy_identity: 1 }, reviewRequiredRows: 1, invalidMetadataRows: 0,
        rows: [{ legacyIdSha256: sha256("append-checkpoint") }], planDigest },
      projectionWork: { truthRows: 1, compatibilityRows: 1, ftsRows: 1, vectorRows: 1,
        relationProjectionRows: 1, outboxRows: 3 },
      decision: { deltaWriteReady: true, requiresFreshEncryptedSnapshot: true,
        finalRecallCutoverReady: false },
      authorizesDeltaWrite: false,
    };
    await writePrivateJson(planPath, plan);
    const planSha256 = sha256(await readFile(planPath));
    const applyPath = join(paths.root, "append-apply.json");
    await writePrivateJson(applyPath, {
      schemaVersion: 1, phase: "clawlore-v2-live-v1-append-delta",
      rolloutId: "append-rollout-r1", status: "applied", appliedAt: now, planDigest, planSha256,
      snapshotReceiptSha256: sha256("receipt"), snapshotArchiveSha256: sha256("archive"),
      source: { v1Rows: 16, memoryTruthLogicalDigest: sha256("truth"), unchanged: true },
      v2: { beforeRows: 15, afterRows: 16, deltaRows: 1, activeRows: 0, candidateRows: 16,
        archivedRows: 0, existingCanonicalRowsChanged: 0, existingLifecycleRowsChanged: 0,
        existingVerificationRowsChanged: 0, existingEvidenceRowsChanged: 0 },
      projections: { compatibilityRows: 16, ftsRows: 16, vectorRows: 16,
        relationProjectionRows: 16, newProcessedOutboxRows: 3, pendingOutboxRows: 0 },
      database: { integrity: "ok", foreignKeyViolations: 0 },
      runtime: { v1FallbackReads: true, existingCandidateLifecycleMutationEnabled: false,
        contextEngineEnabled: false, promptMutationEnabled: false, finalRecallCutoverEnabled: false },
    });
    const acceptancePath = join(paths.root, "append-acceptance.json");
    await writePrivateJson(acceptancePath, {
      schemaVersion: 1, phase: "clawlore-v2-live-v1-append-delta-acceptance",
      rolloutId: "append-rollout-r1", status: "pass", planDigest,
      source: { v1Rows: 16, v2Rows: 16, sourceLogicalDigestUnchanged: true },
      delta: { rows: 1, reflectionSummaryRows: 0, operationalCheckpointRows: 1,
        candidateRows: 1, unverifiedRows: 1, legacyIdentityDebtRows: 1 },
      preserved: { existingCanonicalRowsChanged: 0, existingLifecycleRowsChanged: 0,
        existingVerificationRowsChanged: 0, existingEvidenceRowsChanged: 0 },
      lifecycle: { activeRows: 0, candidateRows: 16, archivedRows: 0 },
      projections: { compatibilityRows: 16, ftsRows: 16, vectorRows: 16, relationRows: 16,
        newProcessedOutboxRows: 3, pendingOutboxRows: 0 },
      database: { integrity: "ok", foreignKeyViolations: 0, v1DoctorHealthy: true,
        sqlVectorScopeMatch: true },
      runtime: { v1FallbackReads: true, existingCandidateLifecycleMutationEnabled: false,
        contextEngineEnabled: false, promptMutationEnabled: false, finalRecallCutoverEnabled: false },
    });
    const rebased = createLivePostV1AppendCandidatePlanV1({ sourcePath: paths.source,
      priorBaselinePath: paths.baselinePath, deltaPlanPath: planPath, applyReceiptPath: applyPath,
      acceptancePath, proposedRolloutId: "post-append-candidate-r1", now: () => new Date(now) });
    assert.equal(rebased.source.candidateRows, 16);
    assert.equal(rebased.candidatePromotionPlan.counts.hold_candidate, 16);
    assert.deepEqual(rebased.appendRebase.addedItemIdSha256, [sha256(itemId)]);
    const drift = new DatabaseSync(paths.source);
    drift.prepare("UPDATE memory_sources SET evidence_json=? WHERE source_id='source:append-checkpoint'")
      .run(JSON.stringify({ classification: "command_trace", verificationDebt: "legacy_identity",
        reviewRequired: true }));
    drift.close();
    assert.throws(() => createLivePostV1AppendCandidatePlanV1({ sourcePath: paths.source,
      priorBaselinePath: paths.baselinePath, deltaPlanPath: planPath, applyReceiptPath: applyPath,
      acceptancePath, proposedRolloutId: "post-append-candidate-r2" }), /conservative checkpoint shape/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
