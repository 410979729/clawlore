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
const { planCandidateUnsafeTraceRewriteProposalV1 } =
  jiti("../src/v2/application/candidate-unsafe-trace-rewrite-proposal.ts");
const {
  acceptLiveCandidateUnsafeTraceRewriteProposalV1,
  createLiveCandidateUnsafeTraceRewriteProposalPlanV1,
} = jiti("../src/v2/operator/live-candidate-unsafe-trace-rewrite-proposal.ts");
const {
  createLiveCandidateUnsafeTraceRewritePostcheckV1,
  executeLiveCandidateUnsafeTraceRewriteV1,
} = jiti("../src/v2/operator/live-candidate-unsafe-trace-rewrite-apply.ts");
const { inspectLegacySqliteSnapshotV2 } =
  jiti("../src/v2/operator/legacy-v1-snapshot.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const now = "2026-07-14T09:00:00.000Z";
const ARCHIVE_ROWS = 99;
const REWRITE_ROWS = 32;
const NON_TARGET_ROWS = 1;

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
  return sha256(await readFile(path));
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

function insertRow(db, { seed, content, lifecycle = "candidate", withLineage = true }) {
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
      "private", "durable", "test", null, null, null, null, null, lifecycle, "unverified", null, now, now);
  db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
    .run(revisionId, itemId, 1, content, lifecycle, "unverified", null, now);
  db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)")
    .run(`source:${seed}`, revisionId, "legacy", seed, now, withLineage
      ? JSON.stringify({ classification: "reflection_summary", sourceLineageReceiptV1: lineage })
      : "{}");
  db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)")
    .run(`acl:${seed}`, itemId, "joy", "private", "{}", now);
  db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)")
    .run(`event:${seed}`, itemId, revisionId, "remembered", "fixture", "fixture", now);
  db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)").run(itemId, content, "{}");
  db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, content, "fact");
  db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)")
    .run(itemId, seed, "fixture", "verified", now);
  db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)").run(itemId, "none", now);
  return { itemId, revisionId, lineage };
}

function sourceState(db) {
  const scalar = (sql) => Number(Object.values(db.prepare(sql).get())[0] ?? 0);
  return {
    v1Rows: scalar("SELECT COUNT(*) FROM memory_truth"),
    v2Rows: scalar("SELECT COUNT(*) FROM memory_items"),
    candidateRows: scalar("SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'"),
    activeRows: scalar("SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
    archivedRows: scalar("SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'"),
    compatibilityRows: scalar("SELECT COUNT(*) FROM memory_fts_compat_v2"),
    currentFtsRows: scalar("SELECT COUNT(*) FROM memory_fts_v2"),
    vectorRows: scalar("SELECT COUNT(*) FROM memory_vector_projection_v2"),
    relationRows: scalar("SELECT COUNT(*) FROM memory_relation_projection_v2"),
    pendingOutboxRows: scalar("SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
  };
}

function beforeArchiveSource() {
  const rows = ARCHIVE_ROWS + REWRITE_ROWS + NON_TARGET_ROWS;
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

function specifications(rewriteDesigns) {
  return rewriteDesigns.map((row, index) => ({
    itemIdSha256: row.itemIdSha256,
    currentRevisionIdSha256: row.currentRevisionIdSha256,
    rewriteDesign: row.rewriteDesign,
    knowledgeCoverage: index % 2 === 0 ? "covered_by_existing_truth" : "materially_new_bounded_truth",
    knowledgeEvidenceDigest: sha256(`knowledge-evidence:${index}`),
    proposedContents: row.rewriteDesign === "segment_oversized_result"
      ? [
        `Bounded durable segment ${index}-a records the first reusable outcome without any command, path, tool payload, or transient runtime envelope.`,
        `Bounded durable segment ${index}-b records the second reusable outcome with explicit scope and verification requirements only.`,
      ]
      : [`Bounded durable result ${index} preserves only the reusable outcome and its verification boundary without operational trace material.`],
  }));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-unsafe-trace-rewrite-"));
  const source = join(root, "live.sqlite3");
  const dispositionPlanPath = join(root, "disposition-plan.json");
  const archiveApplyPath = join(root, "archive-apply.json");
  const archivePostcheckPath = join(root, "archive-postcheck.json");
  const rewritePayloadPath = join(root, "rewrite-payload.json");
  const db = new DatabaseSync(source);
  createSchema(db);
  const archiveRows = [];
  for (let index = 0; index < ARCHIVE_ROWS; index += 1) {
    const seed = `archive-${index}`;
    const content = `Archived unsafe trace ${index}`;
    const inserted = insertRow(db, { seed, content, lifecycle: "archived", withLineage: false });
    archiveRows.push({
      itemIdSha256: sha256(inserted.itemId),
      currentRevisionIdSha256: sha256(inserted.revisionId),
      contentDigest: sha256(content),
      normalizedContentDigest: sha256(normalizeCandidateContentV1(content)),
      sourceLineageReceiptDigest: sha256(`archive-lineage:${index}`),
      category: "fact",
      captureSafetyPattern: "command-hints-block",
      captureSafetyLane: "command_trace_rejection_review",
      reason: "pure_operational_trace",
      resultDigest: sha256(`archive-result:${index}`),
      proposedAction: "soft_archive_under_separate_exact_apply",
      mutationReady: false,
      proposedLifecycle: "archived",
      proposedVerification: "unverified",
    });
  }
  const rewriteDesigns = [];
  for (let index = 0; index < REWRITE_ROWS; index += 1) {
    const seed = `rewrite-${index}`;
    const oversized = index < 7;
    const content = `request ${index}\nCommand hints:\n- inspect transient state\nResult:\n${
      oversized ? "x".repeat(4_100) : `reusable result ${index}`}`;
    const inserted = insertRow(db, { seed, content });
    rewriteDesigns.push({
      itemIdSha256: sha256(inserted.itemId),
      currentRevisionIdSha256: sha256(inserted.revisionId),
      contentDigest: sha256(content),
      normalizedContentDigest: sha256(normalizeCandidateContentV1(content)),
      sourceLineageReceiptDigest: sha256(JSON.stringify(inserted.lineage)),
      category: "fact",
      captureSafetyPattern: "command-hints-block",
      captureSafetyLane: oversized
        ? "oversized_operational_trace_rewrite_review"
        : "command_trace_rejection_review",
      reason: oversized
        ? "oversized_trace_requires_segmentation"
        : "semantic_result_requires_rewrite_review",
      resultDigest: sha256(`rewrite-result:${index}`),
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
  insertRow(db, { seed: "non-target", content: "This bounded non-target candidate must remain unchanged throughout proposal planning." });
  const postArchiveSource = sourceState(db);
  db.close();
  await chmod(source, 0o600);
  archiveRows.sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
  rewriteDesigns.sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
  const summary = {
    targetRows: 131,
    softArchiveRows: 99,
    boundedRewriteRows: 32,
    oversizedSegmentationRows: 7,
    semanticExtractionRows: 25,
    mutationReadyRows: 0,
    liveBindingMismatches: 0,
  };
  const dispositionCore = {
    proposedDispositionId: "unsafe-trace-disposition-r1",
    adjudicationPlanDigest: sha256("adjudication-plan"),
    adjudicationPlanSha256: sha256("adjudication-file"),
    source: beforeArchiveSource(),
    summary,
    archiveRows,
    rewriteDesigns,
  };
  const dispositionPlan = {
    schemaVersion: 1,
    phase: "clawlore-candidate-unsafe-trace-disposition-plan",
    createdAt: now,
    proposedDispositionId: dispositionCore.proposedDispositionId,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    emitsContentDigests: true,
    softArchiveProposalRows: 99,
    boundedRewriteDesignRows: 32,
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
    ...dispositionCore,
    planDigest: sha256(JSON.stringify(dispositionCore)),
  };
  const dispositionPlanSha256 = await writePrivateJson(dispositionPlanPath, dispositionPlan);
  const archiveApply = {
    schemaVersion: 1,
    phase: "clawlore-candidate-unsafe-trace-soft-archive-live-apply",
    rolloutId: "unsafe-trace-archive-r1",
    status: "applied",
    appliedAt: now,
    planDigest: dispositionPlan.planDigest,
    planSha256: dispositionPlanSha256,
    acceptanceSha256: sha256("archive-acceptance"),
    snapshotReceiptSha256: sha256("snapshot-receipt"),
    snapshotArchiveSha256: sha256("snapshot-archive"),
    sourceBefore: beforeArchiveSource(),
    sourceAfter: postArchiveSource,
    archive: {
      targetRows: 99,
      candidateRowsArchived: 99,
      protectedRewriteRows: 32,
      protectedRewriteRowsChanged: 0,
      newArchivedRevisionRows: 99,
      oldRevisionRowsSuperseded: 99,
      newSourceRows: 99,
      newRelationRows: 99,
      newEventRows: 99,
      currentContentRowsChanged: 0,
      currentVerificationRowsChanged: 0,
      addressRowsChanged: 0,
      aclRowsChanged: 0,
      nonTargetRowsChanged: 0,
    },
    projections: {
      compatibilityRowsChanged: 0,
      currentFtsRowsChanged: 0,
      vectorRowsChanged: 0,
      relationProjectionRowsChanged: 0,
      pendingOutboxRowsChanged: 0,
    },
    database: { integrity: "ok", foreignKeyViolations: 0 },
    runtime: {
      v1FallbackReads: true,
      existingCandidateLifecycleMutationEnabled: false,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
  const archiveApplySha256 = await writePrivateJson(archiveApplyPath, archiveApply);
  const archivePostcheck = {
    schemaVersion: 1,
    phase: "clawlore-candidate-unsafe-trace-soft-archive-postcheck",
    verifiedAt: now,
    status: "pass",
    rolloutId: archiveApply.rolloutId,
    planDigest: dispositionPlan.planDigest,
    planSha256: dispositionPlanSha256,
    applyReceiptSha256: archiveApplySha256,
    source: postArchiveSource,
    targetBinding: {
      archivedRows: 99,
      protectedRewriteRows: 32,
      protectedRewriteRowsChanged: 0,
      validDispositionReceiptRows: 99,
      supersedesRelationRows: 99,
      archivedEventRows: 99,
      projectionBindingRows: 99,
      mismatches: 0,
    },
    database: { integrity: "ok", foreignKeyViolations: 0 },
    runtime: archiveApply.runtime,
  };
  const archivePostcheckSha256 = await writePrivateJson(archivePostcheckPath, archivePostcheck);
  const payloadCore = {
    dispositionPlanDigest: dispositionPlan.planDigest,
    dispositionPlanSha256,
    archiveApplyReceiptSha256: archiveApplySha256,
    archivePostcheckSha256,
    specifications: specifications(rewriteDesigns),
  };
  const rewritePayload = {
    schemaVersion: 1,
    phase: "clawlore-unsafe-trace-rewrite-payload",
    createdAt: now,
    ...payloadCore,
    readOnly: true,
    containsProposedMemoryContent: true,
    containsOriginalMemoryContent: false,
    containsTranscriptContent: false,
    containsRawIdentifiers: false,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    payloadDigest: sha256(JSON.stringify(payloadCore)),
  };
  await writePrivateJson(rewritePayloadPath, rewritePayload);
  return {
    root,
    source,
    dispositionPlanPath,
    archiveApplyPath,
    archivePostcheckPath,
    rewritePayloadPath,
    dispositionPlan,
    rewritePayload,
  };
}

function createPlan(paths) {
  return createLiveCandidateUnsafeTraceRewriteProposalPlanV1({
    sourcePath: paths.source,
    dispositionPlanPath: paths.dispositionPlanPath,
    archiveApplyReceiptPath: paths.archiveApplyPath,
    archivePostcheckPath: paths.archivePostcheckPath,
    rewritePayloadPath: paths.rewritePayloadPath,
    proposedRewriteId: "unsafe-trace-rewrite-r1",
    now: () => new Date("2026-07-14T09:01:00.000Z"),
  });
}

test("unsafe trace rewrite proposal covers exact 7/25 lane with bounded capture-safe outputs", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source, { readOnly: true });
    const corpus = db.prepare("SELECT content FROM memory_items WHERE lifecycle='candidate'").all().map((row) => row.content);
    db.close();
    const proposal = planCandidateUnsafeTraceRewriteProposalV1(
      paths.dispositionPlan.rewriteDesigns,
      paths.rewritePayload.specifications,
      corpus,
    );
    assert.deepEqual(proposal.summary, {
      targetRows: 32,
      oversizedSegmentationRows: 7,
      semanticExtractionRows: 25,
      proposedDurableRows: 39,
      captureSafeProposals: 39,
      coveredByExistingTruthRows: 16,
      materiallyNewTruthRows: 16,
      corpusCollisionRows: 0,
      mutationReadyRows: 0,
    });
    assert.equal(proposal.rows.every((row) => row.mutationReady === false), true);
    assert.equal(proposal.rows.every((row) => row.outputs.every((output) => output.captureSafetyAllowed)), true);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("unsafe trace rewrite proposal rejects incomplete, unsafe, colliding, and over-bounded payloads", async () => {
  const paths = await fixture();
  try {
    const rows = paths.dispositionPlan.rewriteDesigns;
    const specs = paths.rewritePayload.specifications;
    assert.throws(() => planCandidateUnsafeTraceRewriteProposalV1(rows, specs.slice(1), []), /cover every held row/);
    const unsafe = structuredClone(specs);
    unsafe[0].proposedContents = [
      "Command hints:\n- expose transient trace material\nResult:\nTool output that must never enter durable memory.",
    ];
    assert.throws(() => planCandidateUnsafeTraceRewriteProposalV1(rows, unsafe, []), /capture-unsafe/);
    const colliding = structuredClone(specs);
    assert.throws(() => planCandidateUnsafeTraceRewriteProposalV1(
      rows,
      colliding,
      [colliding[0].proposedContents[0]],
    ), /collides with current corpus/);
    const overBounded = structuredClone(specs);
    const semantic = overBounded.find((specification) => specification.rewriteDesign === "extract_durable_result");
    semantic.proposedContents.push("A second semantic result is deliberately outside the exact one-row extraction contract.");
    assert.throws(() => planCandidateUnsafeTraceRewriteProposalV1(rows, overBounded, []), /bounded output count/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("live unsafe trace rewrite plan is redacted, query-only, exact, and independently accepted", async () => {
  const paths = await fixture();
  try {
    const proposalPlanPath = join(paths.root, "proposal-plan.json");
    const plan = createPlan(paths);
    await writePrivateJson(proposalPlanPath, plan);
    assert.equal(plan.summary.targetRows, 32);
    assert.equal(plan.summary.proposedDurableRows, 39);
    assert.equal(plan.appendOnlySourceExtensionRows, 0);
    assert.equal(plan.authorizesContentRewrite, false);
    assert.equal(plan.requiresSeparateExactApply, true);
    const serialized = JSON.stringify(plan);
    for (const specification of paths.rewritePayload.specifications) {
      for (const proposedContent of specification.proposedContents) {
        assert.equal(serialized.includes(proposedContent), false);
      }
    }
    assert.equal(serialized.includes("Command hints:"), false);
    const acceptance = acceptLiveCandidateUnsafeTraceRewriteProposalV1({
      sourcePath: paths.source,
      dispositionPlanPath: paths.dispositionPlanPath,
      archiveApplyReceiptPath: paths.archiveApplyPath,
      archivePostcheckPath: paths.archivePostcheckPath,
      rewritePayloadPath: paths.rewritePayloadPath,
      proposalPlanPath,
      now: () => new Date("2026-07-14T09:02:00.000Z"),
    });
    assert.equal(acceptance.status, "pass");
    assert.equal(acceptance.liveBindingMismatches, 0);
    assert.equal(acceptance.authorizesContentRewrite, false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("live unsafe trace rewrite plan tolerates only fully converged append-only growth", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source);
    insertRow(db, { seed: "later-checkpoint", content: "A later converged checkpoint remains outside all protected rewrite targets." });
    db.close();
    const plan = createPlan(paths);
    assert.equal(plan.appendOnlySourceExtensionRows, 1);
    assert.equal(plan.source.v1Rows, plan.postArchiveSource.v1Rows + 1);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }

  const stale = await fixture();
  try {
    const db = new DatabaseSync(stale.source);
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)")
      .run("v1-only", "unmirrored source append", "fact", "private", 9999, "{}");
    db.close();
    assert.throws(() => createPlan(stale), /fully converged append-only extension/);
  } finally {
    await rm(stale.root, { recursive: true, force: true });
  }
});

test("unsafe trace rewrite acceptance fails closed on payload tamper and protected-row drift", async () => {
  const paths = await fixture();
  try {
    const payload = JSON.parse(await readFile(paths.rewritePayloadPath, "utf8"));
    payload.specifications[0].proposedContents[0] += " changed";
    await writePrivateJson(paths.rewritePayloadPath, payload);
    assert.throws(() => createPlan(paths), /payload digest is invalid/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }

  const drifted = await fixture();
  try {
    const proposalPlanPath = join(drifted.root, "proposal-plan.json");
    await writePrivateJson(proposalPlanPath, createPlan(drifted));
    const db = new DatabaseSync(drifted.source);
    db.prepare("UPDATE memory_items SET content=? WHERE item_id=?")
      .run("changed protected target", "legacy:rewrite-0");
    db.close();
    assert.throws(() => acceptLiveCandidateUnsafeTraceRewriteProposalV1({
      sourcePath: drifted.source,
      dispositionPlanPath: drifted.dispositionPlanPath,
      archiveApplyReceiptPath: drifted.archiveApplyPath,
      archivePostcheckPath: drifted.archivePostcheckPath,
      rewritePayloadPath: drifted.rewritePayloadPath,
      proposalPlanPath,
    }), /live target no longer matches/);
  } finally {
    await rm(drifted.root, { recursive: true, force: true });
  }
});

async function liveApplyFixture({ oneOutputPerTarget = true } = {}) {
  const paths = await fixture();
  if (oneOutputPerTarget) {
    const payload = JSON.parse(await readFile(paths.rewritePayloadPath, "utf8"));
    payload.specifications = payload.specifications.map((specification) => ({
      ...specification,
      proposedContents: [specification.proposedContents[0]],
    }));
    const payloadCore = {
      dispositionPlanDigest: payload.dispositionPlanDigest,
      dispositionPlanSha256: payload.dispositionPlanSha256,
      archiveApplyReceiptSha256: payload.archiveApplyReceiptSha256,
      archivePostcheckSha256: payload.archivePostcheckSha256,
      specifications: payload.specifications,
    };
    payload.payloadDigest = sha256(JSON.stringify(payloadCore));
    await writePrivateJson(paths.rewritePayloadPath, payload);
    paths.rewritePayload = payload;
  }
  const planPath = join(paths.root, "rewrite-plan.json");
  const acceptancePath = join(paths.root, "rewrite-acceptance.json");
  const baselinePath = join(paths.root, "candidate-baseline.json");
  const archivePath = join(paths.root, "fresh.clawlore2");
  const snapshotReceiptPath = join(paths.root, "fresh.receipt.json");
  const applyReceiptPath = join(paths.root, "rewrite-apply.json");
  const plan = createPlan(paths);
  await writePrivateJson(planPath, plan);
  const acceptance = acceptLiveCandidateUnsafeTraceRewriteProposalV1({
    sourcePath: paths.source,
    dispositionPlanPath: paths.dispositionPlanPath,
    archiveApplyReceiptPath: paths.archiveApplyPath,
    archivePostcheckPath: paths.archivePostcheckPath,
    rewritePayloadPath: paths.rewritePayloadPath,
    proposalPlanPath: planPath,
    now: () => new Date("2026-07-14T09:02:00.000Z"),
  });
  await writePrivateJson(acceptancePath, acceptance);
  const db = new DatabaseSync(paths.source, { readOnly: true });
  const promotionRows = db.prepare("SELECT item_id FROM memory_items WHERE lifecycle='candidate' ORDER BY item_id")
    .all().map((row) => ({
      itemIdSha256: sha256(row.item_id),
      disposition: "hold_candidate",
      reasonCodes: ["automatic_source_operator_review_missing"],
    }));
  db.close();
  const baselineDigest = sha256(JSON.stringify(promotionRows));
  await writePrivateJson(baselinePath, {
    schemaVersion: 1,
    phase: "clawlore-post-assignment-candidate-plan",
    createdAt: "2026-07-14T09:02:30.000Z",
    proposedRolloutId: "unsafe-rewrite-baseline-r1",
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    source: {
      ...plan.source,
      baselineV1Rows: plan.source.v1Rows,
      unmirroredV1Rows: 0,
      missingLegacyRowsForV2: 0,
      candidateBaselineUnchanged: true,
      sourceUnchangedDuringPlan: true,
    },
    candidatePromotionPlan: {
      schemaVersion: 1,
      phase: "clawlore-candidate-promotion-plan",
      readOnly: true,
      emitsItemIds: false,
      automaticPromotionRows: 0,
      authorizesLiveMutation: false,
      counts: { eligible_for_promotion: 0, hold_candidate: promotionRows.length, quarantine: 0, preserve_archived: 0 },
      rows: promotionRows,
      planDigest: baselineDigest,
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
  });
  const legacy = await inspectLegacySqliteSnapshotV2(paths.source);
  const archive = Buffer.from("fixture encrypted snapshot");
  await writeFile(archivePath, archive, { mode: 0o600 });
  await chmod(archivePath, 0o600);
  await writePrivateJson(snapshotReceiptPath, {
    schemaVersion: 1,
    phase: "clawlore-v2-live-encrypted-snapshot",
    createdAt: "2026-07-14T09:03:00.000Z",
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
  return {
    ...paths,
    plan,
    planPath,
    acceptancePath,
    baselinePath,
    baselineDigest,
    archivePath,
    snapshotReceiptPath,
    applyReceiptPath,
  };
}

test("unsafe trace rewrite exact apply changes 32 contents and independently postchecks protected state", async () => {
  const paths = await liveApplyFixture();
  try {
    const receipt = await executeLiveCandidateUnsafeTraceRewriteV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      payloadPath: paths.rewritePayloadPath,
      proposalAcceptancePath: paths.acceptancePath,
      candidateBaselinePath: paths.baselinePath,
      candidateBaselineDigest: paths.baselineDigest,
      snapshotArchivePath: paths.archivePath,
      snapshotReceiptPath: paths.snapshotReceiptPath,
      rolloutId: "clawlore-v2-unsafe-trace-rewrite-apply-r1",
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-14T09:04:00.000Z"),
    });
    assert.equal(receipt.rewrite.targetRows, 32);
    assert.equal(receipt.rewrite.currentLifecycleRowsChanged, 0);
    assert.equal(receipt.rewrite.nonTargetRowsChanged, 0);
    assert.equal(receipt.projections.currentFtsRowsChanged, 32);
    await writePrivateJson(paths.applyReceiptPath, receipt);
    const postcheck = createLiveCandidateUnsafeTraceRewritePostcheckV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      payloadPath: paths.rewritePayloadPath,
      proposalAcceptancePath: paths.acceptancePath,
      applyReceiptPath: paths.applyReceiptPath,
      rolloutId: "clawlore-v2-unsafe-trace-rewrite-apply-r1",
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-14T09:05:00.000Z"),
    });
    assert.equal(postcheck.status, "pass");
    assert.equal(postcheck.targetBinding.rewrittenRows, 32);
    assert.equal(postcheck.targetBinding.mismatches, 0);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_items WHERE revision_no=2").get().rows, 32);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_revisions WHERE lifecycle='superseded'").get().rows, 32);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_relations WHERE relation_type='supersedes'").get().rows, 32);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM clawlore_rollouts_v2").get().rows, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM projection_outbox").get().rows, 0);
    db.close();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("unsafe trace rewrite exact apply rejects multi-output materialization, target drift, and stale snapshot", async () => {
  const multi = await liveApplyFixture({ oneOutputPerTarget: false });
  try {
    await assert.rejects(executeLiveCandidateUnsafeTraceRewriteV1({
      sourcePath: multi.source,
      planPath: multi.planPath,
      payloadPath: multi.rewritePayloadPath,
      proposalAcceptancePath: multi.acceptancePath,
      candidateBaselinePath: multi.baselinePath,
      candidateBaselineDigest: multi.baselineDigest,
      snapshotArchivePath: multi.archivePath,
      snapshotReceiptPath: multi.snapshotReceiptPath,
      rolloutId: "clawlore-v2-unsafe-trace-rewrite-apply-r1",
      planDigest: multi.plan.planDigest,
      now: () => new Date("2026-07-14T09:04:00.000Z"),
    }), /requires one final output per target/);
  } finally {
    await rm(multi.root, { recursive: true, force: true });
  }

  const drifted = await liveApplyFixture();
  try {
    const db = new DatabaseSync(drifted.source);
    const target = db.prepare("SELECT item_id FROM memory_items WHERE item_id LIKE 'legacy:rewrite-%' ORDER BY item_id LIMIT 1").get();
    db.prepare("UPDATE memory_items SET content=content || ' drift' WHERE item_id=?").run(target.item_id);
    db.close();
    await assert.rejects(executeLiveCandidateUnsafeTraceRewriteV1({
      sourcePath: drifted.source,
      planPath: drifted.planPath,
      payloadPath: drifted.rewritePayloadPath,
      proposalAcceptancePath: drifted.acceptancePath,
      candidateBaselinePath: drifted.baselinePath,
      candidateBaselineDigest: drifted.baselineDigest,
      snapshotArchivePath: drifted.archivePath,
      snapshotReceiptPath: drifted.snapshotReceiptPath,
      rolloutId: "clawlore-v2-unsafe-trace-rewrite-apply-r1",
      planDigest: drifted.plan.planDigest,
      now: () => new Date("2026-07-14T09:04:00.000Z"),
    }), /no longer matches/);
  } finally {
    await rm(drifted.root, { recursive: true, force: true });
  }

  const stale = await liveApplyFixture();
  try {
    await assert.rejects(executeLiveCandidateUnsafeTraceRewriteV1({
      sourcePath: stale.source,
      planPath: stale.planPath,
      payloadPath: stale.rewritePayloadPath,
      proposalAcceptancePath: stale.acceptancePath,
      candidateBaselinePath: stale.baselinePath,
      candidateBaselineDigest: stale.baselineDigest,
      snapshotArchivePath: stale.archivePath,
      snapshotReceiptPath: stale.snapshotReceiptPath,
      rolloutId: "clawlore-v2-unsafe-trace-rewrite-apply-r1",
      planDigest: stale.plan.planDigest,
      now: () => new Date("2026-07-14T11:04:00.000Z"),
    }), /snapshot is invalid, stale/);
  } finally {
    await rm(stale.root, { recursive: true, force: true });
  }
});
