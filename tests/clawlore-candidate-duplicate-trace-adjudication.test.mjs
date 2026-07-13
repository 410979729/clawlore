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
const { adjudicateCandidateDuplicateTracesV1 } =
  jiti("../src/v2/application/candidate-duplicate-trace-adjudication.ts");
const { createLiveCandidateDuplicateTraceAdjudicationPlanV1 } =
  jiti("../src/v2/operator/live-candidate-duplicate-trace-adjudication.ts");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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
    recordedAt: "2026-07-13T08:00:00.000Z",
    preservesLifecycle: true,
    preservesVerification: true,
  };
}

function captureRow(id, content, groupSize, pattern, oversized = false) {
  return {
    itemIdSha256: sha256(`legacy:${id}`),
    currentRevisionIdSha256: sha256(`revision:${id}`),
    contentDigest: sha256(content),
    normalizedContentDigest: sha256(normalizeCandidateContentV1(content)),
    sourceLineageReceiptDigest: sha256(JSON.stringify(lineageReceipt())),
    category: "fact",
    captureSafetyReason: "operational-trace",
    captureSafetyPattern: pattern,
    exactDuplicate: true,
    oversized,
    lane: "exact_duplicate_operational_trace_review",
    requiredActions: ["review_exact_duplicate_group", "operator_decision_required"],
    proposedLifecycle: "candidate",
    proposedVerification: "unverified",
    groupSize,
  };
}

const archiveContent = "Command hints:\n- inspect trace\nFiles:\n/tmp/trace\nResult: completed";
const rewriteContent = "Files:\n/tmp/design\nResult: durable architecture note needing rewrite";

function fixtureRows() {
  return [
    captureRow("archive-a", archiveContent, 2, "command-hints-block"),
    captureRow("archive-b", archiveContent, 2, "command-hints-block"),
    captureRow("rewrite-a", rewriteContent, 2, "tool-fields-block"),
    captureRow("rewrite-b", rewriteContent, 2, "tool-fields-block"),
  ];
}

function decisions() {
  return [
    {
      normalizedContentDigest: sha256(normalizeCandidateContentV1(archiveContent)),
      expectedGroupSize: 2,
      disposition: "propose_soft_archive",
      basis: "covered_by_existing_truth",
      evidenceDigest: sha256("knowledge:trace-covered"),
    },
    {
      normalizedContentDigest: sha256(normalizeCandidateContentV1(rewriteContent)),
      expectedGroupSize: 2,
      disposition: "hold_for_bounded_rewrite",
      basis: "durable_fact_requires_rewrite",
      evidenceDigest: sha256("review:architecture-rewrite"),
    },
  ];
}

test("duplicate-trace adjudication separates reversible archive proposals from rewrite holds", () => {
  const result = adjudicateCandidateDuplicateTracesV1(fixtureRows(), decisions());
  assert.deepEqual(result.summary, {
    targetGroups: 2,
    targetRows: 4,
    softArchiveGroups: 1,
    softArchiveRows: 2,
    rewriteHoldGroups: 1,
    rewriteHoldRows: 2,
    mutationReadyRows: 0,
  });
  assert.equal(result.rows.every((row) => row.mutationReady === false), true);
  assert.equal(result.rows.every((row) => row.proposedLifecycle === "candidate"), true);
});

test("duplicate-trace adjudication requires complete group decisions and safe disposition bases", () => {
  assert.throws(
    () => adjudicateCandidateDuplicateTracesV1(fixtureRows(), decisions().slice(0, 1)),
    /cover every exact group/,
  );
  const unsafe = decisions();
  unsafe[0] = { ...unsafe[0], basis: "durable_fact_requires_rewrite" };
  assert.throws(
    () => adjudicateCandidateDuplicateTracesV1(fixtureRows(), unsafe),
    /soft-archive proposal requires/,
  );
});

async function liveFixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-duplicate-trace-adjudication-"));
  const source = join(root, "live.sqlite3");
  const capturePlanPath = join(root, "capture-safety.json");
  const decisionsPath = join(root, "decisions.json");
  const rows = [
    ["archive-a", archiveContent],
    ["archive-b", archiveContent],
    ["rewrite-a", rewriteContent],
    ["rewrite-b", rewriteContent],
  ];
  const receipt = lineageReceipt();
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
  for (const [id, content] of rows) {
    const itemId = `legacy:${id}`;
    const revisionId = `revision:${id}`;
    db.prepare("INSERT INTO memory_truth VALUES (?,?)")
      .run(id, JSON.stringify({ source: "reflection-summary" }));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?)")
      .run(itemId, revisionId, content, "fact", "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)")
      .run(`source:${id}`, revisionId, JSON.stringify({
        classification: "reflection_summary",
        sourceLineageReceiptV1: receipt,
      }));
    for (const table of ["memory_fts_compat_v2", "memory_fts_v2", "memory_vector_projection_v2", "memory_relation_projection_v2"]) {
      db.prepare(`INSERT INTO ${table} VALUES (?)`).run(itemId);
    }
  }
  db.close();
  await chmod(source, 0o600);

  const captureRows = fixtureRows().map(({ groupSize: _groupSize, ...row }) => row);
  const sourceState = {
    v1Rows: 4, v2Rows: 4, candidateRows: 4, activeRows: 0, archivedRows: 0,
    compatibilityRows: 4, currentFtsRows: 4, vectorRows: 4, relationRows: 4,
    pendingOutboxRows: 0,
  };
  const counts = {
    exact_duplicate_operational_trace_review: 4,
    oversized_operational_trace_rewrite_review: 0,
    command_trace_rejection_review: 0,
    tool_payload_rejection_review: 0,
  };
  const summary = {
    targetRows: 4, exactDuplicateRows: 4, oversizedRows: 0,
    duplicateAndOversizedRows: 0, uniqueOversizedRows: 0, directTraceReviewRows: 0,
    automaticArchiveRows: 0, mutationReadyRows: 0,
  };
  const captureCore = {
    proposedReviewId: "clawlore-v2-capture-safety-r1",
    contentQualityPlanDigest: sha256("content-quality-plan"),
    contentQualityPreviewSha256: sha256("content-quality-file"),
    source: sourceState,
    counts,
    summary,
    rows: captureRows,
  };
  await writeFile(capturePlanPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: "clawlore-candidate-capture-safety-review-plan",
    createdAt: "2026-07-13T09:00:00.000Z",
    proposedReviewId: captureCore.proposedReviewId,
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
    ...captureCore,
    planDigest: sha256(JSON.stringify(captureCore)),
  }, null, 2)}\n`, { mode: 0o600 });
  const captureBytes = await readFile(capturePlanPath);
  const decisionCore = {
    captureSafetyPlanDigest: sha256(JSON.stringify(captureCore)),
    captureSafetyPreviewSha256: sha256(captureBytes),
    decisions: decisions(),
  };
  await writeFile(decisionsPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: "clawlore-duplicate-trace-operator-decisions",
    createdAt: "2026-07-13T09:30:00.000Z",
    ...decisionCore,
    readOnly: true,
    authorizesSoftArchive: false,
    authorizesContentRewrite: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    decisionDigest: sha256(JSON.stringify(decisionCore)),
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, source, capturePlanPath, decisionsPath };
}

test("live duplicate-trace plan is exact, redacted, query-only, and non-authorizing", async () => {
  const paths = await liveFixture();
  try {
    const plan = createLiveCandidateDuplicateTraceAdjudicationPlanV1({
      sourcePath: paths.source,
      captureSafetyPreviewPath: paths.capturePlanPath,
      decisionControlPath: paths.decisionsPath,
      proposedAdjudicationId: "clawlore-v2-duplicate-trace-r1",
      now: () => new Date("2026-07-13T10:00:00.000Z"),
    });
    assert.equal(plan.summary.softArchiveRows, 2);
    assert.equal(plan.summary.rewriteHoldRows, 2);
    assert.equal(plan.authorizesSoftArchive, false);
    assert.equal(plan.authorizesContentRewrite, false);
    assert.equal(plan.authorizesLifecycleMutation, false);
    assert.equal(plan.requiresSeparateExactApply, true);
    assert.equal(plan.appendOnlySourceExtensionRows, 0);
    const serialized = JSON.stringify(plan);
    for (const marker of ["Command hints", "durable architecture note", "legacy:archive", "revision:archive", "/tmp/"]) {
      assert.equal(serialized.includes(marker), false);
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("live duplicate-trace plan tolerates only a fully converged candidate append outside its exact targets", async () => {
  const paths = await liveFixture();
  try {
    const db = new DatabaseSync(paths.source);
    const id = "new-checkpoint";
    const itemId = `legacy:${id}`;
    const revisionId = `revision:${id}`;
    db.prepare("INSERT INTO memory_truth VALUES (?,?)")
      .run(id, JSON.stringify({ source: "checkpoint" }));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?)")
      .run(itemId, revisionId, "new isolated checkpoint", "decision", "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)")
      .run(`source:${id}`, revisionId, JSON.stringify({ classification: "operational_checkpoint" }));
    for (const table of ["memory_fts_compat_v2", "memory_fts_v2", "memory_vector_projection_v2", "memory_relation_projection_v2"]) {
      db.prepare(`INSERT INTO ${table} VALUES (?)`).run(itemId);
    }
    db.close();
    const plan = createLiveCandidateDuplicateTraceAdjudicationPlanV1({
      sourcePath: paths.source,
      captureSafetyPreviewPath: paths.capturePlanPath,
      decisionControlPath: paths.decisionsPath,
      proposedAdjudicationId: "clawlore-v2-duplicate-trace-r1",
    });
    assert.equal(plan.appendOnlySourceExtensionRows, 1);
    assert.equal(plan.source.v1Rows, 5);
    assert.equal(plan.source.v2Rows, 5);
    assert.equal(plan.summary.targetRows, 4);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("live duplicate-trace plan rejects tampered decisions and current-row drift", async () => {
  const paths = await liveFixture();
  try {
    const control = JSON.parse(await readFile(paths.decisionsPath, "utf8"));
    control.decisions[0].expectedGroupSize = 3;
    await writeFile(paths.decisionsPath, `${JSON.stringify(control)}\n`, { mode: 0o600 });
    assert.throws(() => createLiveCandidateDuplicateTraceAdjudicationPlanV1({
      sourcePath: paths.source,
      captureSafetyPreviewPath: paths.capturePlanPath,
      decisionControlPath: paths.decisionsPath,
      proposedAdjudicationId: "clawlore-v2-duplicate-trace-r1",
    }), /decision digest is invalid/);

    const repaired = await liveFixture();
    try {
      const db = new DatabaseSync(repaired.source);
      db.prepare("UPDATE memory_items SET content=? WHERE item_id=?")
        .run(`${archiveContent}\nchanged`, "legacy:archive-a");
      db.close();
      assert.throws(() => createLiveCandidateDuplicateTraceAdjudicationPlanV1({
        sourcePath: repaired.source,
        captureSafetyPreviewPath: repaired.capturePlanPath,
        decisionControlPath: repaired.decisionsPath,
        proposedAdjudicationId: "clawlore-v2-duplicate-trace-r1",
      }), /live candidate no longer matches/);
    } finally {
      await rm(repaired.root, { recursive: true, force: true });
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
