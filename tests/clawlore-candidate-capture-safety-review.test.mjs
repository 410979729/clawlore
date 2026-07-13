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
const { assessCandidateContentQualityV1 } =
  jiti("../src/v2/application/candidate-content-quality-review.ts");
const { createLiveCandidateCaptureSafetyReviewPlanV1 } =
  jiti("../src/v2/operator/live-candidate-capture-safety-review.ts");
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-capture-safety-review-"));
  const source = join(root, "live.sqlite3");
  const contentPlanPath = join(root, "content-quality.json");
  const duplicate = "Command hints:\n- inspect duplicate\nFiles:\n/tmp/duplicate\nResult: Command completed";
  const rows = [
    ["duplicate-a", duplicate, "fact"],
    ["duplicate-b", duplicate, "fact"],
    ["oversized", `Command hints:\n${"x".repeat(4_050)}\nFiles:\n/tmp/large\nResult: Command completed`, "fact"],
    ["tool", "Files:\n/tmp/tool\nResult: output", "fact"],
    ["command", "Command hints:\n- inspect unique\nFiles:\n/tmp/unique\nResult: Command completed", "decision"],
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
  for (const [id, content, category] of rows) {
    const itemId = `legacy:${id}`;
    const revisionId = `revision:${id}`;
    db.prepare("INSERT INTO memory_truth VALUES (?,?)")
      .run(id, JSON.stringify({ source: "reflection-summary", marker: `private-${id}` }));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?)")
      .run(itemId, revisionId, content, category, "candidate", "unverified");
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
  const assessment = assessCandidateContentQualityV1(
    rows.map(([id, content, category]) => ({
      itemId: `legacy:${id}`,
      currentRevisionId: `revision:${id}`,
      content,
      category,
      lifecycle: "candidate",
      verification: "unverified",
      sourceLineageReceiptDigest: sha256(JSON.stringify(receipt)),
    })),
    rows.map(([, content]) => content),
  );
  const sourceState = {
    v1Rows: 5, v2Rows: 5, candidateRows: 5, activeRows: 0, archivedRows: 0,
    compatibilityRows: 5, currentFtsRows: 5, vectorRows: 5, relationRows: 5,
    pendingOutboxRows: 0,
  };
  const core = {
    proposedReviewId: "clawlore-v2-content-quality-r1",
    remediationPlanDigest: sha256("remediation-plan"),
    remediationPreviewSha256: sha256("remediation-file"),
    source: sourceState,
    counts: assessment.counts,
    summary: assessment.summary,
    rows: assessment.rows,
  };
  await writeFile(contentPlanPath, `${JSON.stringify({
    schemaVersion: 1,
    phase: "clawlore-candidate-content-quality-review-plan",
    createdAt: "2026-07-13T08:30:00.000Z",
    proposedReviewId: core.proposedReviewId,
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    emitsContentDigests: true,
    automaticReviewRows: 0,
    authorizesContentRewrite: false,
    authorizesSoftArchive: false,
    authorizesHardDelete: false,
    authorizesLifecycleMutation: false,
    authorizesVerificationMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    requiresOperatorSemanticReview: true,
    ...core,
    planDigest: sha256(JSON.stringify(core)),
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, source, contentPlanPath };
}

test("capture-safety review creates four exact redacted operator batches without mutation authority", async () => {
  const paths = await fixture();
  try {
    const plan = createLiveCandidateCaptureSafetyReviewPlanV1({
      sourcePath: paths.source,
      contentQualityPreviewPath: paths.contentPlanPath,
      proposedReviewId: "clawlore-v2-capture-safety-r1",
      now: () => new Date("2026-07-13T09:00:00.000Z"),
    });
    assert.deepEqual(plan.counts, {
      exact_duplicate_operational_trace_review: 2,
      oversized_operational_trace_rewrite_review: 1,
      command_trace_rejection_review: 1,
      tool_payload_rejection_review: 1,
    });
    assert.deepEqual(plan.summary, {
      targetRows: 5,
      exactDuplicateRows: 2,
      oversizedRows: 1,
      duplicateAndOversizedRows: 0,
      uniqueOversizedRows: 1,
      directTraceReviewRows: 2,
      automaticArchiveRows: 0,
      mutationReadyRows: 0,
    });
    assert.equal(plan.authorizesRejectionMutation, false);
    assert.equal(plan.authorizesContentRewrite, false);
    assert.equal(plan.authorizesSoftArchive, false);
    assert.equal(plan.authorizesLifecycleMutation, false);
    assert.equal(plan.rows.every((row) => row.proposedLifecycle === "candidate" && row.proposedVerification === "unverified"), true);
    const serialized = JSON.stringify(plan);
    for (const marker of ["Command hints", "Result: output", "private-command", "legacy:command", "revision:command"]) {
      assert.equal(serialized.includes(marker), false);
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("capture-safety review rejects a mutating or tampered content-quality control", async () => {
  const paths = await fixture();
  try {
    const plan = JSON.parse(await readFile(paths.contentPlanPath, "utf8"));
    plan.authorizesSoftArchive = true;
    await writeFile(paths.contentPlanPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
    assert.throws(() => createLiveCandidateCaptureSafetyReviewPlanV1({
      sourcePath: paths.source,
      contentQualityPreviewPath: paths.contentPlanPath,
      proposedReviewId: "clawlore-v2-capture-safety-r1",
    }), /content-quality control is invalid/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("capture-safety review fails closed when live content drifts", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source);
    db.prepare("UPDATE memory_items SET content=? WHERE item_id=?")
      .run("Command hints:\n- changed\nFiles:\n/tmp/changed\nResult: Command completed", "legacy:command");
    db.close();
    assert.throws(() => createLiveCandidateCaptureSafetyReviewPlanV1({
      sourcePath: paths.source,
      contentQualityPreviewPath: paths.contentPlanPath,
      proposedReviewId: "clawlore-v2-capture-safety-r1",
    }), /live candidate no longer matches/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
