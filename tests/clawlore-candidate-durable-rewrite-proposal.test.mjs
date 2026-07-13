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
  db.exec(`CREATE TABLE memory_truth(id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
    CREATE TABLE memory_items(item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,
      content TEXT NOT NULL,category TEXT NOT NULL,lifecycle TEXT NOT NULL,verification TEXT NOT NULL);
    CREATE TABLE memory_sources(source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_fts_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_relation_projection_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE projection_outbox(outbox_id TEXT PRIMARY KEY,processed_at TEXT);`);
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
    db.prepare("INSERT INTO memory_truth VALUES (?,?)").run(id, JSON.stringify({ source: "reflection-summary" }));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?)")
      .run(itemId, revisionId, content, category, "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)").run(`source:${id}`, revisionId, JSON.stringify({
      classification: "reflection_summary",
      sourceLineageReceiptV1: lineageReceipt(),
    }));
    for (const table of ["memory_fts_compat_v2", "memory_fts_v2", "memory_vector_projection_v2", "memory_relation_projection_v2"]) {
      db.prepare(`INSERT INTO ${table} VALUES (?)`).run(itemId);
    }
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
    db.prepare("INSERT INTO memory_truth VALUES (?,?)").run(id, JSON.stringify({ source: "checkpoint" }));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?)")
      .run(itemId, revisionId, "new isolated checkpoint", "decision", "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)").run(`source:${id}`, revisionId, "{}");
    for (const table of ["memory_fts_compat_v2", "memory_fts_v2", "memory_vector_projection_v2", "memory_relation_projection_v2"]) {
      db.prepare(`INSERT INTO ${table} VALUES (?)`).run(itemId);
    }
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
