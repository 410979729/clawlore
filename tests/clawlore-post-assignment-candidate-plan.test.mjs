import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createLivePostAssignmentCandidatePlanV1 } =
  jiti("../src/v2/operator/live-post-assignment-candidate-plan.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function stateDigest(row) {
  return sha256(JSON.stringify({
    itemId: row.itemId,
    currentRevisionId: row.revisionId,
    addressJson: row.addressJson,
    lifecycle: row.lifecycle,
    verification: row.verification,
  }));
}

function planCore(plan) {
  return {
    proposedRolloutId: plan.proposedRolloutId,
    remediationPlanDigest: plan.remediationPlanDigest,
    remediationPreviewSha256: plan.remediationPreviewSha256,
    sessionsRegistrySha256: plan.sessionsRegistrySha256,
    source: plan.source,
    summary: plan.summary,
    decisions: plan.decisions,
    rows: plan.rows,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-post-assignment-plan-"));
  const source = join(root, "live.sqlite3");
  const planPath = join(root, "assignment-plan.json");
  const acceptancePath = join(root, "assignment-acceptance.json");
  const rolloutId = "clawlore-v2-evidence-assignment-fixture-r1";
  const addressJson = JSON.stringify({
    schemaVersion: 2,
    tenantId: "tenant",
    principalId: "legacy:unresolved",
    agentId: "main",
    visibility: "private",
    retention: "durable",
  });
  const rows = [
    { id: "direct", classification: "auto_capture", verification: "unverified", decision: "propose_private_principal_evidence_assignment" },
    { id: "conversation", classification: "auto_capture", verification: "unverified", decision: "propose_conversation_boundary_evidence_assignment" },
    { id: "manual", classification: "explicit_manual", verification: "user_confirmed", decision: "keep_candidate_unassigned" },
    { id: "unknown", classification: "unknown_legacy", verification: "unverified", decision: "retain_quarantine" },
  ].map((row) => ({
    ...row,
    itemId: `legacy:${row.id}`,
    revisionId: `revision:${row.id}`,
    sourceId: `source:${row.id}`,
    lifecycle: "candidate",
    addressJson,
  }));
  const plan = {
    schemaVersion: 1,
    phase: "clawlore-evidence-assignment-plan",
    proposedRolloutId: rolloutId,
    planDigest: "",
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    automaticPromotionRows: 0,
    authorizesEvidenceWrite: false,
    authorizesLifecycleMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    remediationPlanDigest: sha256("remediation"),
    remediationPreviewSha256: sha256("remediation-preview"),
    sessionsRegistrySha256: sha256("registry"),
    source: {
      v1Rows: 4,
      v2Rows: 4,
      candidateRows: 4,
      activeRows: 0,
      archivedRows: 0,
      compatibilityRows: 4,
      pendingOutboxRows: 0,
    },
    summary: {
      proposedEvidenceAssignmentRows: 2,
      explicitHoldRows: 1,
      quarantineRows: 1,
      lifecycleRowsChanged: 0,
      verificationRowsChanged: 0,
    },
    decisions: {
      propose_private_principal_evidence_assignment: 1,
      propose_conversation_boundary_evidence_assignment: 1,
      keep_candidate_unassigned: 1,
      await_external_source_receipt: 0,
      retain_quarantine: 1,
    },
    rows: rows.map((row) => {
      const planned = {
        itemIdSha256: sha256(row.itemId),
        currentStateDigest: stateDigest(row),
        lane: row.decision,
        decision: row.decision,
        postLifecycle: "candidate",
        postVerification: row.verification,
        lifecycleMutationAllowed: false,
      };
      if (row.decision.startsWith("propose_")) {
        planned.resolver = row.decision.includes("private")
          ? "sessions_registry_exact_private_v1"
          : "sessions_registry_exact_conversation_v1";
        planned.resolverEvidenceDigest = sha256(`resolver:${row.id}`);
        planned.proposedEvidencePayloadDigest = sha256(`payload:${row.id}`);
      }
      return planned;
    }),
  };
  plan.planDigest = sha256(JSON.stringify(planCore(plan)));
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(id TEXT PRIMARY KEY);
    CREATE TABLE memory_items(
      item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,address_json TEXT NOT NULL,
      lifecycle TEXT NOT NULL,verification TEXT NOT NULL);
    CREATE TABLE memory_sources(
      source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE projection_outbox(outbox_id TEXT PRIMARY KEY,processed_at TEXT);`);
  const assignedAt = "2026-07-12T14:43:05.692Z";
  for (const row of rows) {
    const planned = plan.rows.find((value) => value.itemIdSha256 === sha256(row.itemId));
    const evidence = { classification: row.classification, privateMarker: "must-not-emit" };
    if (row.decision.startsWith("propose_")) {
      evidence.registryResolvedEvidenceV1 = {
        schemaVersion: 1,
        rolloutId,
        planDigest: plan.planDigest,
        evidenceKind: row.decision.includes("private") ? "direct-principal" : "conversation-boundary",
        resolver: planned.resolver,
        resolverEvidenceDigest: planned.resolverEvidenceDigest,
        currentStateDigest: planned.currentStateDigest,
        proposedEvidencePayloadDigest: planned.proposedEvidencePayloadDigest,
        assignedAt,
        preservesLifecycle: true,
        preservesVerification: true,
      };
    }
    db.prepare("INSERT INTO memory_truth VALUES (?)").run(row.id);
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?)")
      .run(row.itemId, row.revisionId, row.addressJson, row.lifecycle, row.verification);
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)")
      .run(row.sourceId, row.revisionId, JSON.stringify(evidence));
    db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?)").run(row.itemId);
  }
  db.close();
  await chmod(source, 0o600);
  const planBytes = `${JSON.stringify(plan, null, 2)}\n`;
  await writeFile(planPath, planBytes, { mode: 0o600 });
  const acceptance = {
    schemaVersion: 1,
    phase: "clawlore-v2-live-evidence-assignment",
    rolloutId,
    status: "applied",
    appliedAt: assignedAt,
    planDigest: plan.planDigest,
    planSha256: sha256(planBytes),
    source: { memoryTruthRows: 4, memoryTruthLogicalDigest: sha256("truth"), unchanged: true },
    evidence: {
      rowsWritten: 2,
      directPrincipalRows: 1,
      conversationBoundaryRows: 1,
      manualRowsChanged: 0,
      externalSourceReceiptRowsChanged: 0,
      quarantineRowsChanged: 0,
      nonTargetEvidenceRowsChanged: 0,
    },
    canonical: {
      memoryItemRowsChanged: 0,
      lifecycleRowsChanged: 0,
      verificationRowsChanged: 0,
      addressRowsChanged: 0,
      pendingOutboxRowsChanged: 0,
      compatibilityRowsChanged: 0,
    },
    database: { integrity: "ok", foreignKeyViolations: 0 },
    runtime: {
      v1FallbackReads: true,
      lifecycleMutationEnabled: false,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
  await writeFile(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`, { mode: 0o600 });
  return { root, source, planPath, acceptancePath };
}

async function appendAcceptedDelta(paths) {
  const deltaAcceptancePath = join(paths.root, "delta-acceptance.json");
  const addressJson = JSON.stringify({
    schemaVersion: 2,
    tenantId: "tenant",
    principalId: "legacy:unresolved",
    agentId: "main",
    visibility: "private",
    retention: "durable",
  });
  const deltaRows = [
    { id: "delta-reflection", classification: "reflection_summary" },
    { id: "delta-checkpoint", classification: "operational_checkpoint" },
  ];
  const db = new DatabaseSync(paths.source);
  db.exec(`CREATE TABLE memory_fts_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_relation_projection_v2(item_id TEXT PRIMARY KEY);`);
  for (const row of db.prepare("SELECT item_id FROM memory_items").all()) {
    db.prepare("INSERT INTO memory_fts_v2 VALUES (?)").run(row.item_id);
    db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?)").run(row.item_id);
    db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?)").run(row.item_id);
  }
  for (const row of deltaRows) {
    const itemId = `legacy:${row.id}`;
    const revisionId = `revision:${row.id}`;
    db.prepare("INSERT INTO memory_truth VALUES (?)").run(row.id);
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?)")
      .run(itemId, revisionId, addressJson, "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)")
      .run(`source:${row.id}`, revisionId, JSON.stringify({
        classification: row.classification,
        verificationDebt: "legacy_identity",
        reviewRequired: true,
      }));
    db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?)").run(itemId);
    db.prepare("INSERT INTO memory_fts_v2 VALUES (?)").run(itemId);
    db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?)").run(itemId);
    db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?)").run(itemId);
  }
  db.close();
  const acceptance = {
    schemaVersion: 1,
    phase: "clawlore-v2-live-v1-append-delta-acceptance",
    rolloutId: "clawlore-v2-v1-delta-migration-fixture-r2",
    status: "pass",
    verifiedAt: "2026-07-13T00:23:19.000Z",
    planDigest: sha256("delta-plan"),
    source: { v1Rows: 6, v2Rows: 6, sourceLogicalDigestUnchanged: true },
    delta: {
      rows: 2,
      reflectionSummaryRows: 1,
      operationalCheckpointRows: 1,
      candidateRows: 2,
      unverifiedRows: 2,
      legacyIdentityDebtRows: 2,
    },
    preserved: {
      existingCanonicalRowsChanged: 0,
      existingLifecycleRowsChanged: 0,
      existingVerificationRowsChanged: 0,
      existingEvidenceRowsChanged: 0,
    },
    lifecycle: { activeRows: 0, candidateRows: 6, archivedRows: 0 },
    projections: {
      compatibilityRows: 6,
      ftsRows: 6,
      vectorRows: 6,
      relationRows: 6,
      newProcessedOutboxRows: 6,
      pendingOutboxRows: 0,
    },
    database: {
      integrity: "ok",
      foreignKeyViolations: 0,
      v1DoctorHealthy: true,
      sqlVectorScopeMatch: true,
    },
    runtime: {
      v1FallbackReads: true,
      existingCandidateLifecycleMutationEnabled: false,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
  await writeFile(deltaAcceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`, { mode: 0o600 });
  return deltaAcceptancePath;
}

test("post-assignment candidate plan validates new evidence without inferring ownership", async () => {
  const paths = await fixture();
  try {
    const result = createLivePostAssignmentCandidatePlanV1({
      sourcePath: paths.source,
      assignmentPlanPath: paths.planPath,
      assignmentAcceptancePath: paths.acceptancePath,
      proposedRolloutId: "clawlore-v2-candidate-promotion-fixture-r2",
      now: () => new Date("2026-07-12T15:00:00.000Z"),
    });
    assert.equal(result.assignment.rowsValidated, 2);
    assert.equal(result.assignment.directPrincipalRows, 1);
    assert.equal(result.assignment.conversationBoundaryRows, 1);
    assert.deepEqual(result.candidatePromotionPlan.counts, {
      eligible_for_operator_promotion: 0,
      hold_candidate: 3,
      quarantine: 1,
      preserve_archived: 0,
    });
    assert.equal(result.decision.lifecycleRolloutSelectable, false);
    assert.equal(result.decision.finalRecallCutoverBlockedByUnmirroredV1, false);
    assert.equal(result.authorizesLifecycleMutation, false);
    assert.equal(result.liveMutation.evidenceRowsChanged, 0);
    assert.equal(JSON.stringify(result).includes("legacy:direct"), false);
    assert.equal(JSON.stringify(result).includes("must-not-emit"), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("post-assignment candidate plan tolerates unrelated append-only V1 rows but blocks cutover", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source);
    db.prepare("INSERT INTO memory_truth VALUES (?)").run("new-unmirrored-v1-row");
    db.close();
    const result = createLivePostAssignmentCandidatePlanV1({
      sourcePath: paths.source,
      assignmentPlanPath: paths.planPath,
      assignmentAcceptancePath: paths.acceptancePath,
      proposedRolloutId: "clawlore-v2-candidate-promotion-fixture-r2",
    });
    assert.equal(result.source.baselineV1Rows, 4);
    assert.equal(result.source.v1Rows, 5);
    assert.equal(result.source.unmirroredV1Rows, 1);
    assert.equal(result.source.candidateBaselineUnchanged, true);
    assert.equal(result.decision.finalRecallCutoverBlockedByUnmirroredV1, true);
    assert.equal(result.authorizesFinalRecall, false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("post-assignment candidate plan binds an accepted delta into a complete candidate baseline", async () => {
  const paths = await fixture();
  try {
    const deltaAcceptancePath = await appendAcceptedDelta(paths);
    const result = createLivePostAssignmentCandidatePlanV1({
      sourcePath: paths.source,
      assignmentPlanPath: paths.planPath,
      assignmentAcceptancePath: paths.acceptancePath,
      deltaAcceptancePath,
      proposedRolloutId: "clawlore-v2-candidate-promotion-fixture-r3",
      now: () => new Date("2026-07-13T01:00:00.000Z"),
    });
    assert.equal(result.source.v1Rows, 6);
    assert.equal(result.source.v2Rows, 6);
    assert.equal(result.source.candidateRows, 6);
    assert.equal(result.source.unmirroredV1Rows, 0);
    assert.equal(result.source.currentFtsRows, 6);
    assert.equal(result.source.vectorRows, 6);
    assert.equal(result.source.relationRows, 6);
    assert.deepEqual(result.candidatePromotionPlan.counts, {
      eligible_for_operator_promotion: 0,
      hold_candidate: 5,
      quarantine: 1,
      preserve_archived: 0,
    });
    assert.equal(result.delta.rowsValidated, 2);
    assert.equal(result.delta.reflectionSummaryRows, 1);
    assert.equal(result.delta.operationalCheckpointRows, 1);
    assert.equal(result.decision.lifecycleRolloutSelectable, false);
    assert.equal(result.decision.finalRecallCutoverBlockedByUnmirroredV1, false);
    assert.equal(result.authorizesLifecycleMutation, false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("post-assignment candidate plan rejects accepted-delta evidence drift", async () => {
  const paths = await fixture();
  try {
    const deltaAcceptancePath = await appendAcceptedDelta(paths);
    const db = new DatabaseSync(paths.source);
    const row = db.prepare("SELECT evidence_json FROM memory_sources WHERE source_id=?")
      .get("source:delta-reflection");
    const evidence = JSON.parse(row.evidence_json);
    evidence.verificationDebt = "none";
    db.prepare("UPDATE memory_sources SET evidence_json=? WHERE source_id=?")
      .run(JSON.stringify(evidence), "source:delta-reflection");
    db.close();
    assert.throws(() => createLivePostAssignmentCandidatePlanV1({
      sourcePath: paths.source,
      assignmentPlanPath: paths.planPath,
      assignmentAcceptancePath: paths.acceptancePath,
      deltaAcceptancePath,
      proposedRolloutId: "clawlore-v2-candidate-promotion-fixture-r3",
    }), /delta candidate state does not match/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("post-assignment candidate plan fails closed on evidence-shape drift", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source);
    const row = db.prepare("SELECT evidence_json FROM memory_sources WHERE source_id='source:direct'").get();
    const evidence = JSON.parse(row.evidence_json);
    evidence.registryResolvedEvidenceV1.unapprovedField = "drift";
    db.prepare("UPDATE memory_sources SET evidence_json=? WHERE source_id='source:direct'")
      .run(JSON.stringify(evidence));
    db.close();
    assert.throws(() => createLivePostAssignmentCandidatePlanV1({
      sourcePath: paths.source,
      assignmentPlanPath: paths.planPath,
      assignmentAcceptancePath: paths.acceptancePath,
      proposedRolloutId: "clawlore-v2-candidate-promotion-fixture-r2",
    }), /shape is invalid/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("post-assignment candidate plan does not alter the live database", async () => {
  const paths = await fixture();
  try {
    const before = sha256(await readFile(paths.source));
    createLivePostAssignmentCandidatePlanV1({
      sourcePath: paths.source,
      assignmentPlanPath: paths.planPath,
      assignmentAcceptancePath: paths.acceptancePath,
      proposedRolloutId: "clawlore-v2-candidate-promotion-fixture-r2",
    });
    assert.equal(sha256(await readFile(paths.source)), before);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
