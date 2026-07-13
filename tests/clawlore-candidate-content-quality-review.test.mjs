import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createLiveCandidateContentQualityReviewPlanV1 } =
  jiti("../src/v2/operator/live-candidate-content-quality-review.ts");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function receipt() {
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
    recordedAt: "2026-07-13T07:42:15.918Z",
    preservesLifecycle: true,
    preservesVerification: true,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-content-quality-"));
  const source = join(root, "live.sqlite3");
  const remediation = join(root, "remediation.json");
  const rows = [
    ["safe", "Joy prefers concise completion reports.", "preference"],
    ["unsafe", "Command hints:\nrun task\nFiles: /tmp/output\nResult: Command completed", "fact"],
    ["duplicate-a", "Keep the exact bounded migration decision.", "decision"],
    ["duplicate-b", "Keep the exact bounded migration decision.", "decision"],
    ["oversized", "A".repeat(4_001), "fact"],
  ];
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
      .run(id, JSON.stringify({ source: "reflection-summary", privateMarker: `private-${id}` }));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?)")
      .run(itemId, revisionId, content, category, "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)")
      .run(`source:${id}`, revisionId, JSON.stringify({
        classification: "reflection_summary",
        sourceLineageReceiptV1: receipt(),
      }));
    for (const table of ["memory_fts_compat_v2", "memory_fts_v2", "memory_vector_projection_v2", "memory_relation_projection_v2"]) {
      db.prepare(`INSERT INTO ${table} VALUES (?)`).run(itemId);
    }
  }
  db.close();
  await chmod(source, 0o600);
  const sourceState = {
    v1Rows: 5, v2Rows: 5, candidateRows: 5, activeRows: 0, archivedRows: 0,
    compatibilityRows: 5, pendingOutboxRows: 0, currentFtsRows: 5,
    vectorRows: 5, relationRows: 5,
  };
  const remediationRows = rows.map(([id]) => ({
    itemIdSha256: sha256(`legacy:${id}`),
    lane: "source_lineage_content_review",
    requiredActions: ["review_content_quality", "operator_review", "keep_candidate_until_verified"],
  }));
  const counts = {
    registry_private_assignment_review: 0, registry_conversation_assignment_review: 0,
    registry_other_boundary_review: 0, assigned_private_evidence_review: 0,
    assigned_conversation_evidence_review: 0, manual_principal_assignment_review: 0,
    derived_system_evidence_review: 0, source_lineage_content_review: 5,
    known_source_evidence_review: 0, unresolved_session_review: 0,
    legacy_provenance_hold_review: 0, policy_quarantine_review: 0,
    conflicting_registry_quarantine: 0, legacy_agent_alias_quarantine: 0,
    opaque_reference_quarantine: 0, unknown_legacy_quarantine: 0,
  };
  const summary = {
    assignmentReviewRows: 0, evidenceReviewRows: 5, quarantineRows: 0,
    policyHoldRows: 5, policyQuarantineRows: 0, mutationReadyRows: 0,
  };
  const core = {
    baselinePhase: "clawlore-post-assignment-candidate-plan",
    baselinePromotionPlanDigest: sha256("baseline"),
    baselinePreviewSha256: sha256("baseline-file"),
    source: sourceState,
    counts,
    summary,
    rows: remediationRows,
  };
  await writeFile(remediation, JSON.stringify({
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
    ...core,
    planDigest: sha256(JSON.stringify(core)),
  }), { mode: 0o600 });
  return { root, source, remediation };
}

test("candidate content quality plan is exact, redacted, and query-only", async () => {
  const paths = await fixture();
  try {
    const plan = createLiveCandidateContentQualityReviewPlanV1({
      sourcePath: paths.source,
      remediationPreviewPath: paths.remediation,
      proposedReviewId: "clawlore-v2-content-quality-r1",
      now: () => new Date("2026-07-13T08:30:00.000Z"),
    });
    assert.deepEqual(plan.counts, {
      capture_safety_reject_review: 1,
      oversized_content_review: 1,
      exact_duplicate_review: 2,
      manual_semantic_review: 1,
    });
    assert.deepEqual(plan.summary, {
      targetRows: 5,
      structurallyReviewableRows: 4,
      captureSafetyRejectedRows: 1,
      exactDuplicateRows: 2,
      exactDuplicateGroups: 1,
      oversizedRows: 1,
      manualSemanticReviewRows: 1,
      mutationReadyRows: 0,
    });
    assert.equal(plan.authorizesContentRewrite, false);
    assert.equal(plan.authorizesSoftArchive, false);
    assert.equal(plan.authorizesHardDelete, false);
    assert.equal(plan.authorizesLifecycleMutation, false);
    assert.equal(plan.authorizesVerificationMutation, false);
    assert.equal(plan.rows.every((row) => row.postLifecycle === "candidate" && row.postVerification === "unverified"), true);
    const serialized = JSON.stringify(plan);
    for (const marker of ["Joy prefers", "Command hints", "private-safe", "legacy:safe", "revision:safe"]) {
      assert.equal(serialized.includes(marker), false);
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("candidate content quality plan fails closed on an invalid lineage receipt", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source);
    const row = db.prepare("SELECT evidence_json FROM memory_sources WHERE source_id=?").get("source:safe");
    const evidence = JSON.parse(row.evidence_json);
    evidence.sourceLineageReceiptV1.authorizesLifecycleChange = true;
    db.prepare("UPDATE memory_sources SET evidence_json=? WHERE source_id=?")
      .run(JSON.stringify(evidence), "source:safe");
    db.close();
    assert.throws(() => createLiveCandidateContentQualityReviewPlanV1({
      sourcePath: paths.source,
      remediationPreviewPath: paths.remediation,
      proposedReviewId: "clawlore-v2-content-quality-r1",
    }), /invalid source-lineage receipt/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("candidate content quality plan rejects live V1/V2 drift", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source);
    db.prepare("INSERT INTO memory_truth VALUES (?,?)").run("new-v1", "{}");
    db.close();
    assert.throws(() => createLiveCandidateContentQualityReviewPlanV1({
      sourcePath: paths.source,
      remediationPreviewPath: paths.remediation,
      proposedReviewId: "clawlore-v2-content-quality-r1",
    }), /live source no longer matches/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
