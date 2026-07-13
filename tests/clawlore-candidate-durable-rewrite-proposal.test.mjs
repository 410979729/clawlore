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
const { planCandidateDurableRewriteProposalV1 } =
  jiti("../src/v2/application/candidate-durable-rewrite-proposal.ts");
const { createLiveCandidateDurableRewriteProposalPlanV1 } =
  jiti("../src/v2/operator/live-candidate-durable-rewrite-proposal.ts");
const { executeLiveCandidateDurableRewriteV1 } =
  jiti("../src/v2/operator/live-candidate-durable-rewrite-apply.ts");
const { inspectLegacySqliteSnapshotV2 } =
  jiti("../src/v2/operator/legacy-v1-snapshot.ts");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const originalContents = {
  control: "Files:\n/tmp/local-control\nResult: local collaboration control plane",
  capability: "Command hints:\n- inspect memory capability\nResult: storage does not activate capability",
  episode: "Command hints:\n- review episode\nResult: record episode before reviewer",
};

const proposedContents = {
  control: "Local multi-agent collaboration needs one authoritative control plane for task identity, authorization, routing, acknowledgements, and result acceptance; transport adapters such as MCP remain replaceable and are not independent truth sources.",
  capability: "Durable memory is evidence, not an agent capability by itself. Recall must pass identity, scope, lifecycle, verification, safety, and runtime-capability gates before it can influence tools, prompts, or autonomous behavior.",
  episode: "Every tool-backed completed task should first remain as an auditable candidate episode independent of reviewer outcome. Reviewer acceptance governs reusable playbook extraction or promotion, not whether the underlying episode evidence is retained.",
};

function lineageReceipt() {
  return {
    schemaVersion: 1,
    evidenceKind: "source-lineage-receipt",
    supportsSourceLineageOnly: true,
    authorizesLifecycleChange: false,
    authorizesVerificationChange: false,
    classification: "reflection_summary",
    sourceEvidenceDigest: sha256("source"),
    eventEvidenceDigest: sha256("event"),
    rolloutId: "lineage-rollout-r1",
    planDigest: sha256("lineage-plan"),
    proposedReceiptPayloadDigest: sha256("lineage-payload"),
    recordedAt: "2026-07-13T09:00:00.000Z",
    preservesLifecycle: true,
    preservesVerification: true,
  };
}

function adjudicationRow(id, content, category, evidenceDigest) {
  return {
    itemIdSha256: sha256(`legacy:${id}`),
    currentRevisionIdSha256: sha256(`revision:${id}`),
    contentDigest: sha256(content),
    normalizedContentDigest: sha256(normalizeCandidateContentV1(content)),
    sourceLineageReceiptDigest: sha256(JSON.stringify(lineageReceipt())),
    category,
    captureSafetyReason: "operational-trace",
    captureSafetyPattern: content.startsWith("Files:") ? "tool-fields-block" : "command-hints-block",
    duplicateGroupSize: 2,
    oversized: false,
    disposition: "hold_for_bounded_rewrite",
    basis: "durable_fact_requires_rewrite",
    evidenceDigest,
    proposedNextAction: "bounded_rewrite_under_separate_review",
    mutationReady: false,
    proposedLifecycle: "candidate",
    proposedVerification: "unverified",
  };
}

function fixtureRows() {
  return [
    adjudicationRow("control-a", originalContents.control, "decision", sha256("control-evidence")),
    adjudicationRow("control-b", originalContents.control, "decision", sha256("control-evidence")),
    adjudicationRow("capability-a", originalContents.capability, "fact", sha256("capability-evidence")),
    adjudicationRow("capability-b", originalContents.capability, "fact", sha256("capability-evidence")),
    adjudicationRow("episode-a", originalContents.episode, "decision", sha256("episode-evidence")),
    adjudicationRow("episode-b", originalContents.episode, "decision", sha256("episode-evidence")),
  ];
}

function representative(rows, content) {
  const digest = sha256(normalizeCandidateContentV1(content));
  return rows.filter((row) => row.normalizedContentDigest === digest)
    .map((row) => row.itemIdSha256).sort()[0];
}

function specifications(rows = fixtureRows()) {
  return [
    {
      normalizedContentDigest: sha256(normalizeCandidateContentV1(originalContents.control)),
      expectedGroupSize: 2,
      representativeItemIdSha256: representative(rows, originalContents.control),
      factKey: "local_collaboration_control_plane",
      knowledgeCoverage: "materially_new_bounded_truth",
      knowledgeEvidenceDigest: sha256("knowledge-search:control-plane"),
      proposedContent: proposedContents.control,
    },
    {
      normalizedContentDigest: sha256(normalizeCandidateContentV1(originalContents.capability)),
      expectedGroupSize: 2,
      representativeItemIdSha256: representative(rows, originalContents.capability),
      factKey: "memory_capability_boundary",
      knowledgeCoverage: "covered_by_existing_truth",
      knowledgeEvidenceDigest: sha256("docs:clawlore-rfc-runtime-boundary"),
      proposedContent: proposedContents.capability,
    },
    {
      normalizedContentDigest: sha256(normalizeCandidateContentV1(originalContents.episode)),
      expectedGroupSize: 2,
      representativeItemIdSha256: representative(rows, originalContents.episode),
      factKey: "episode_before_reviewer",
      knowledgeCoverage: "covered_by_existing_truth",
      knowledgeEvidenceDigest: sha256("tests:reviewer-skipped-episode-draft"),
      proposedContent: proposedContents.episode,
    },
  ];
}

test("durable rewrite proposal selects one deterministic representative per duplicate group", () => {
  const rows = fixtureRows();
  const plan = planCandidateDurableRewriteProposalV1(rows, specifications(rows), Object.values(originalContents).flatMap((content) => [content, content]));
  assert.deepEqual(plan.summary, {
    targetGroups: 3,
    targetRows: 6,
    rewriteRepresentativeRows: 3,
    postRewriteDedupeHoldRows: 3,
    coveredByExistingTruthGroups: 2,
    materiallyNewTruthGroups: 1,
    captureSafeProposals: 3,
    corpusCollisionRows: 0,
    mutationReadyRows: 0,
  });
  assert.equal(plan.rows.every((row) => row.mutationReady === false), true);
  assert.equal(plan.groups.every((group) => group.captureSafetyAllowed === true), true);
});

test("durable rewrite proposal rejects incomplete, unsafe, colliding, or non-deterministic specifications", () => {
  const rows = fixtureRows();
  const corpus = Object.values(originalContents).flatMap((content) => [content, content]);
  assert.throws(
    () => planCandidateDurableRewriteProposalV1(rows, specifications(rows).slice(0, 2), corpus),
    /cover every held group/,
  );
  const unsafe = specifications(rows);
  unsafe[0] = { ...unsafe[0], proposedContent: "Files:\n/tmp/control\nResult: still unsafe" };
  assert.throws(() => planCandidateDurableRewriteProposalV1(rows, unsafe, corpus), /capture-unsafe/);
  const existingSafeContent = "Existing durable truth already states this safe fact and must not be duplicated by a rewrite proposal.";
  const colliding = specifications(rows);
  colliding[0] = { ...colliding[0], proposedContent: existingSafeContent };
  assert.throws(() => planCandidateDurableRewriteProposalV1(rows, colliding, [...corpus, existingSafeContent]), /collides/);
  const wrongRepresentative = specifications(rows);
  const controlRows = rows.filter((row) => row.normalizedContentDigest === wrongRepresentative[0].normalizedContentDigest);
  wrongRepresentative[0] = {
    ...wrongRepresentative[0],
    representativeItemIdSha256: controlRows.map((row) => row.itemIdSha256).sort()[1],
  };
  assert.throws(() => planCandidateDurableRewriteProposalV1(rows, wrongRepresentative, corpus), /deterministic first/);
});

async function liveFixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-durable-rewrite-"));
  const source = join(root, "live.sqlite3");
  const adjudicationPath = join(root, "adjudication.json");
  const payloadPath = join(root, "payload.json");
  const rows = fixtureRows();
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
  const originals = [
    ["control-a", originalContents.control, "decision"],
    ["control-b", originalContents.control, "decision"],
    ["capability-a", originalContents.capability, "fact"],
    ["capability-b", originalContents.capability, "fact"],
    ["episode-a", originalContents.episode, "decision"],
    ["episode-b", originalContents.episode, "decision"],
  ];
  for (const [id, content, category] of originals) {
    const itemId = `legacy:${id}`;
    const revisionId = `revision:${id}`;
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)")
      .run(id, content, category, "private", 1, JSON.stringify({ source: "reflection-summary" }));
    const now = "2026-07-13T09:00:00.000Z";
    const address = JSON.stringify({ tenantId: "local", principalId: "joy", agentId: "main",
      visibility: "private", retention: "durable", workspaceId: "test" });
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(itemId, revisionId, 1, content, category, address, "local", "joy", "main", "private", "durable",
        "test", null, null, null, null, null, "candidate", "unverified", null, now, now);
    db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
      .run(revisionId, itemId, 1, content, "candidate", "unverified", null, now);
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)").run(`source:${id}`, revisionId, "legacy", id, now, JSON.stringify({
      classification: "reflection_summary",
      sourceLineageReceiptV1: lineageReceipt(),
    }));
    db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)").run(`acl:${id}`, itemId, "joy", "private", "{}", now);
    db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)").run(`event:${id}`, itemId, revisionId, "remembered", "fixture", "fixture", now);
    db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)").run(itemId, content, "{}");
    db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, content, category);
    db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)").run(itemId, id, "fixture", "verified", now);
    db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)").run(itemId, "none", now);
  }
  db.close();
  await chmod(source, 0o600);

  const sourceState = {
    v1Rows: 6, v2Rows: 6, candidateRows: 6, activeRows: 0, archivedRows: 0,
    compatibilityRows: 6, currentFtsRows: 6, vectorRows: 6, relationRows: 6,
    pendingOutboxRows: 0,
  };
  const groupDecisions = specifications(rows).map((specification) => ({
    normalizedContentDigest: specification.normalizedContentDigest,
    expectedGroupSize: 2,
    disposition: "hold_for_bounded_rewrite",
    basis: "durable_fact_requires_rewrite",
    evidenceDigest: rows.find((row) => row.normalizedContentDigest === specification.normalizedContentDigest).evidenceDigest,
  })).sort((left, right) => left.normalizedContentDigest.localeCompare(right.normalizedContentDigest));
  const summary = {
    targetGroups: 3, targetRows: 6, softArchiveGroups: 0, softArchiveRows: 0,
    rewriteHoldGroups: 3, rewriteHoldRows: 6, mutationReadyRows: 0,
  };
  const planRows = [...rows].sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
  const adjudicationCore = {
    proposedAdjudicationId: "clawlore-v2-duplicate-trace-r1",
    captureSafetyPlanDigest: sha256("capture-plan"),
    captureSafetyPreviewSha256: sha256("capture-file"),
    decisionControlDigest: sha256("decision-control"),
    decisionControlSha256: sha256("decision-file"),
    captureSafetySource: sourceState,
    appendOnlySourceExtensionRows: 0,
    source: sourceState,
    summary,
    groups: groupDecisions,
    rows: planRows,
  };
  await writeFile(adjudicationPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: "clawlore-candidate-duplicate-trace-adjudication-plan",
    createdAt: "2026-07-13T10:00:00.000Z",
    proposedAdjudicationId: adjudicationCore.proposedAdjudicationId,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    proposesSoftArchiveRows: 0,
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
  }, null, 2)}\n`, { mode: 0o600 });
  const adjudicationBytes = await readFile(adjudicationPath);
  const payloadCore = {
    adjudicationPlanDigest: sha256(JSON.stringify(adjudicationCore)),
    adjudicationPreviewSha256: sha256(adjudicationBytes),
    specifications: specifications(rows),
  };
  await writeFile(payloadPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: "clawlore-durable-duplicate-rewrite-payload",
    createdAt: "2026-07-13T10:30:00.000Z",
    ...payloadCore,
    readOnly: true,
    containsProposedMemoryContent: true,
    containsOriginalMemoryContent: false,
    containsTranscriptContent: false,
    containsRawIdentifiers: false,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    payloadDigest: sha256(JSON.stringify(payloadCore)),
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, source, adjudicationPath, payloadPath };
}

test("live durable rewrite plan is exact, redacted, query-only, and non-authorizing", async () => {
  const paths = await liveFixture();
  try {
    const plan = createLiveCandidateDurableRewriteProposalPlanV1({
      sourcePath: paths.source,
      adjudicationPreviewPath: paths.adjudicationPath,
      rewritePayloadPath: paths.payloadPath,
      proposedRewriteId: "clawlore-v2-durable-rewrite-r1",
      now: () => new Date("2026-07-13T11:00:00.000Z"),
    });
    assert.equal(plan.summary.rewriteRepresentativeRows, 3);
    assert.equal(plan.summary.postRewriteDedupeHoldRows, 3);
    assert.equal(plan.authorizesContentRewrite, false);
    assert.equal(plan.authorizesSoftArchive, false);
    assert.equal(plan.requiresFreshEncryptedSnapshot, true);
    assert.equal(plan.appendOnlySourceExtensionRows, 0);
    const serialized = JSON.stringify(plan);
    for (const marker of ["Local multi-agent collaboration", "Durable memory is evidence", "Every tool-backed", "legacy:control", "/tmp/"]) {
      assert.equal(serialized.includes(marker), false);
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("live durable rewrite plan tolerates only a fully converged append outside protected targets", async () => {
  const paths = await liveFixture();
  try {
    const db = new DatabaseSync(paths.source);
    const id = "new-checkpoint";
    const itemId = `legacy:${id}`;
    const revisionId = `revision:${id}`;
    const now = "2026-07-13T09:30:00.000Z";
    const address = JSON.stringify({ tenantId: "local", principalId: "joy", agentId: "main",
      visibility: "private", retention: "durable", workspaceId: "test" });
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)")
      .run(id, "new isolated checkpoint", "decision", "private", 2, JSON.stringify({ source: "checkpoint" }));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(itemId, revisionId, 1, "new isolated checkpoint", "decision", address, "local", "joy", "main",
        "private", "durable", "test", null, null, null, null, null, "candidate", "unverified", null, now, now);
    db.prepare("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?)")
      .run(revisionId, itemId, 1, "new isolated checkpoint", "candidate", "unverified", null, now);
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)").run(`source:${id}`, revisionId, "legacy", id, now, "{}");
    db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)").run(`acl:${id}`, itemId, "joy", "private", "{}", now);
    db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)").run(`event:${id}`, itemId, revisionId, "remembered", "fixture", "fixture", now);
    db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?,?,?)").run(itemId, "new isolated checkpoint", "{}");
    db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run(itemId, "new isolated checkpoint", "decision");
    db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)").run(itemId, id, "fixture", "verified", now);
    db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?,?,?)").run(itemId, "none", now);
    db.close();
    const plan = createLiveCandidateDurableRewriteProposalPlanV1({
      sourcePath: paths.source,
      adjudicationPreviewPath: paths.adjudicationPath,
      rewritePayloadPath: paths.payloadPath,
      proposedRewriteId: "clawlore-v2-durable-rewrite-r1",
    });
    assert.equal(plan.appendOnlySourceExtensionRows, 1);
    assert.equal(plan.source.v1Rows, 7);
    assert.equal(plan.summary.targetRows, 6);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("live durable rewrite plan rejects tampered payloads and protected-row drift", async () => {
  const paths = await liveFixture();
  try {
    const payload = JSON.parse(await readFile(paths.payloadPath, "utf8"));
    payload.specifications[0].proposedContent += " changed";
    await writeFile(paths.payloadPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    assert.throws(() => createLiveCandidateDurableRewriteProposalPlanV1({
      sourcePath: paths.source,
      adjudicationPreviewPath: paths.adjudicationPath,
      rewritePayloadPath: paths.payloadPath,
      proposedRewriteId: "clawlore-v2-durable-rewrite-r1",
    }), /payload digest is invalid/);

    const repaired = await liveFixture();
    try {
      const db = new DatabaseSync(repaired.source);
      db.prepare("UPDATE memory_items SET content=? WHERE item_id=?")
        .run(`${originalContents.control}\nchanged`, "legacy:control-a");
      db.close();
      assert.throws(() => createLiveCandidateDurableRewriteProposalPlanV1({
        sourcePath: repaired.source,
        adjudicationPreviewPath: repaired.adjudicationPath,
        rewritePayloadPath: repaired.payloadPath,
        proposedRewriteId: "clawlore-v2-durable-rewrite-r1",
      }), /live candidate no longer matches/);
    } finally {
      await rm(repaired.root, { recursive: true, force: true });
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function liveApplyFixture() {
  const paths = await liveFixture();
  const planPath = join(paths.root, "rewrite-plan.json");
  const acceptancePath = join(paths.root, "rewrite-acceptance.json");
  const baselinePath = join(paths.root, "candidate-baseline.json");
  const archivePath = join(paths.root, "fresh.clawlore2");
  const snapshotReceiptPath = join(paths.root, "fresh.receipt.json");
  const plan = createLiveCandidateDurableRewriteProposalPlanV1({
    sourcePath: paths.source,
    adjudicationPreviewPath: paths.adjudicationPath,
    rewritePayloadPath: paths.payloadPath,
    proposedRewriteId: "clawlore-v2-durable-rewrite-r1",
    now: () => new Date("2026-07-13T11:00:00.000Z"),
  });
  await writePrivateJson(planPath, plan);
  const planSha256 = sha256(await readFile(planPath));
  const payload = JSON.parse(await readFile(paths.payloadPath, "utf8"));
  await writePrivateJson(acceptancePath, {
    schemaVersion: 1,
    phase: "clawlore-candidate-durable-rewrite-proposal-acceptance",
    acceptedAt: "2026-07-13T11:01:00.000Z",
    status: "pass",
    planDigest: plan.planDigest,
    planSha256,
    rewritePayloadDigest: payload.payloadDigest,
    rewritePayloadSha256: sha256(await readFile(paths.payloadPath)),
    summary: plan.summary,
    live: plan.source,
    liveBindingMismatches: 0,
    proposedContentLeak: false,
    rawTraceOrIdentifierLeak: false,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesLifecycleMutation: false,
    requiresFreshEncryptedSnapshot: true,
    requiresSeparateExactApply: true,
  });
  const promotionRows = fixtureRows().map((row) => ({
    itemIdSha256: row.itemIdSha256,
    disposition: "hold_candidate",
    reasonCodes: ["automatic_source_operator_review_missing"],
  }));
  const baselineDigest = sha256(JSON.stringify(promotionRows));
  await writePrivateJson(baselinePath, {
    schemaVersion: 1,
    phase: "clawlore-post-assignment-candidate-plan",
    createdAt: "2026-07-13T11:02:00.000Z",
    proposedRolloutId: "test-baseline-r1",
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    source: {
      ...plan.source,
      baselineV1Rows: 6,
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
      counts: { eligible_for_promotion: 0, hold_candidate: 6, quarantine: 0, preserve_archived: 0 },
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
    createdAt: "2026-07-13T11:03:00.000Z",
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
    ...paths, plan, planPath, acceptancePath, baselinePath, baselineDigest,
    archivePath, snapshotReceiptPath,
  };
}

test("live durable rewrite apply changes exactly three representatives and preserves protected state", async () => {
  const paths = await liveApplyFixture();
  try {
    const receipt = await executeLiveCandidateDurableRewriteV1({
      sourcePath: paths.source,
      planPath: paths.planPath,
      payloadPath: paths.payloadPath,
      proposalAcceptancePath: paths.acceptancePath,
      candidateBaselinePath: paths.baselinePath,
      candidateBaselineDigest: paths.baselineDigest,
      snapshotArchivePath: paths.archivePath,
      snapshotReceiptPath: paths.snapshotReceiptPath,
      rolloutId: "clawlore-v2-durable-rewrite-apply-r1",
      planDigest: paths.plan.planDigest,
      now: () => new Date("2026-07-13T11:04:00.000Z"),
    });
    assert.equal(receipt.rewrite.representativeRows, 3);
    assert.equal(receipt.rewrite.companionRowsChanged, 0);
    assert.equal(receipt.rewrite.currentLifecycleRowsChanged, 0);
    assert.equal(receipt.projections.vectorRowsChanged, 0);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    const rows = db.prepare("SELECT item_id,revision_no,content,lifecycle,verification FROM memory_items ORDER BY item_id").all();
    assert.equal(rows.filter((row) => row.revision_no === 2).length, 3);
    assert.equal(rows.filter((row) => row.revision_no === 1).length, 3);
    assert.equal(rows.every((row) => row.lifecycle === "candidate" && row.verification === "unverified"), true);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_revisions WHERE lifecycle='superseded'").get().rows, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_sources").get().rows, 9);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_relations").get().rows, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM memory_events").get().rows, 9);
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM projection_outbox").get().rows, 0);
    db.close();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("live durable rewrite apply fails closed on target drift or stale snapshot", async () => {
  const drifted = await liveApplyFixture();
  try {
    const db = new DatabaseSync(drifted.source);
    const representative = drifted.plan.rows.find((row) => row.role === "rewrite_representative");
    const target = db.prepare("SELECT item_id FROM memory_items ORDER BY item_id").all()
      .find((row) => sha256(row.item_id) === representative.itemIdSha256);
    db.prepare("UPDATE memory_items SET content=content || ' drift' WHERE item_id=?").run(target.item_id);
    db.close();
    await assert.rejects(executeLiveCandidateDurableRewriteV1({
      sourcePath: drifted.source,
      planPath: drifted.planPath,
      payloadPath: drifted.payloadPath,
      proposalAcceptancePath: drifted.acceptancePath,
      candidateBaselinePath: drifted.baselinePath,
      candidateBaselineDigest: drifted.baselineDigest,
      snapshotArchivePath: drifted.archivePath,
      snapshotReceiptPath: drifted.snapshotReceiptPath,
      rolloutId: "clawlore-v2-durable-rewrite-apply-r1",
      planDigest: drifted.plan.planDigest,
      now: () => new Date("2026-07-13T11:04:00.000Z"),
    }), /no longer matches/);
  } finally {
    await rm(drifted.root, { recursive: true, force: true });
  }

  const stale = await liveApplyFixture();
  try {
    await assert.rejects(executeLiveCandidateDurableRewriteV1({
      sourcePath: stale.source,
      planPath: stale.planPath,
      payloadPath: stale.payloadPath,
      proposalAcceptancePath: stale.acceptancePath,
      candidateBaselinePath: stale.baselinePath,
      candidateBaselineDigest: stale.baselineDigest,
      snapshotArchivePath: stale.archivePath,
      snapshotReceiptPath: stale.snapshotReceiptPath,
      rolloutId: "clawlore-v2-durable-rewrite-apply-r1",
      planDigest: stale.plan.planDigest,
      now: () => new Date("2026-07-13T13:04:00.000Z"),
    }), /snapshot is invalid, stale/);
  } finally {
    await rm(stale.root, { recursive: true, force: true });
  }
});
