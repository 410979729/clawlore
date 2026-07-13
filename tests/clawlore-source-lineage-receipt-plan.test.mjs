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
const { createLiveSourceLineageReceiptPlanV1 } =
  jiti("../src/v2/operator/live-source-lineage-receipt-plan.ts");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-lineage-plan-"));
  const source = join(root, "live.sqlite3");
  const remediation = join(root, "remediation.json");
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(id TEXT PRIMARY KEY,metadata TEXT NOT NULL,metadata_text TEXT NOT NULL);
    CREATE TABLE memory_items(item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,address_json TEXT NOT NULL,
      lifecycle TEXT NOT NULL,verification TEXT NOT NULL);
    CREATE TABLE memory_sources(source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,source_type TEXT NOT NULL,
      external_id TEXT,observed_at TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE TABLE memory_events(event_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_id TEXT NOT NULL,
      event_type TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_fts_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_relation_projection_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE projection_outbox(outbox_id TEXT PRIMARY KEY,processed_at TEXT);`);
  const rows = [
    { id: "reflection", classification: "reflection_summary", lane: "derived_system_evidence_review", eventReason: "rollout-1" },
    { id: "checkpoint", classification: "operational_checkpoint", lane: "derived_system_evidence_review", eventReason: "wrong-rollout" },
    { id: "manual", classification: "explicit_manual", lane: "manual_principal_assignment_review", eventReason: "rollout-1" },
  ];
  for (const row of rows) {
    const itemId = `legacy:${row.id}`;
    const revisionId = `revision:${row.id}`;
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?)")
      .run(row.id, JSON.stringify({ marker: `private-${row.id}` }), `metadata-${row.id}`);
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?)")
      .run(itemId, revisionId, JSON.stringify({ visibility: "private" }), "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)").run(
      `source:${row.id}`, revisionId, "legacy", row.id, "2026-07-13T00:00:00.000Z",
      JSON.stringify({ classification: row.classification, rolloutId: "rollout-1" }),
    );
    db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)").run(
      `event:${row.id}`, itemId, revisionId, "remembered",
      row.id === "reflection" ? "operator:approved-rollout" : "operator:bounded-rollout",
      row.eventReason, "2026-07-13T00:00:00.000Z",
    );
    for (const table of ["memory_fts_compat_v2", "memory_fts_v2", "memory_vector_projection_v2", "memory_relation_projection_v2"]) {
      db.prepare(`INSERT INTO ${table} VALUES (?)`).run(itemId);
    }
  }
  db.close();
  await chmod(source, 0o600);
  const sourceState = {
    v1Rows: 3, v2Rows: 3, candidateRows: 3, activeRows: 0, archivedRows: 0,
    compatibilityRows: 3, pendingOutboxRows: 0, currentFtsRows: 3, vectorRows: 3, relationRows: 3,
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

test("source lineage plan is exact, redacted, and non-authorizing", async () => {
  const paths = await fixture();
  try {
    const plan = createLiveSourceLineageReceiptPlanV1({
      sourcePath: paths.source,
      remediationPreviewPath: paths.remediation,
      proposedRolloutId: "clawlore-v2-source-lineage-20260713-r1",
    });
    assert.deepEqual(plan.summary, {
      derivedSystemRows: 2,
      proposedSourceLineageReceiptRows: 1,
      incompleteLineageRows: 1,
      nonTargetRows: 1,
      lifecycleRowsChanged: 0,
      verificationRowsChanged: 0,
    });
    assert.deepEqual(plan.classifications, { reflection_summary: 1, operational_checkpoint: 1 });
    assert.equal(plan.authorizesEvidenceWrite, false);
    assert.equal(plan.authorizesLifecycleMutation, false);
    assert.equal(plan.authorizesVerificationMutation, false);
    assert.equal(plan.rows.every((row) => row.postLifecycle === "candidate"), true);
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes("legacy:reflection"), false);
    assert.equal(serialized.includes("private-reflection"), false);
    assert.equal(serialized.includes("metadata-reflection"), false);
    assert.equal(serialized.includes("rollout-1"), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("source lineage plan fails closed on remediation or live drift", async () => {
  const paths = await fixture();
  try {
    const preview = JSON.parse(await readFile(paths.remediation, "utf8"));
    preview.rows[0].lane = "known_source_evidence_review";
    await writeFile(paths.remediation, JSON.stringify(preview), { mode: 0o600 });
    assert.throws(() => createLiveSourceLineageReceiptPlanV1({
      sourcePath: paths.source,
      remediationPreviewPath: paths.remediation,
      proposedRolloutId: "clawlore-v2-source-lineage-20260713-r1",
    }), /plan digest is invalid/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
