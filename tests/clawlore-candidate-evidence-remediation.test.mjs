import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createLiveCandidateEvidenceRemediationPlanV1 } =
  jiti("../src/v2/operator/live-candidate-evidence-remediation.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-evidence-remediation-"));
  const source = join(root, "live.sqlite3");
  const registry = join(root, "sessions.json");
  const baseline = join(root, "baseline.json");
  const direct = "agent:main:telegram:default:direct:user-1";
  const group = "agent:main:telegram:group:group-1";
  const rows = [
    ["direct", { source: "auto-capture", sessionKey: direct }, "auto_capture"],
    ["group", { source: "auto-capture", sessionKey: group }, "auto_capture"],
    ["manual", { source: "manual", private_note: "do-not-emit-marker" }, "explicit_manual"],
    ["system", { source: "reflection-summary", source_session: "batch-1" }, "reflection_summary"],
    ["alias", { source: "auto-capture", source_session: "agent:main:main" }, "auto_capture"],
    ["opaque", { source: "auto-capture", source_session: "opaque" }, "auto_capture"],
    ["unknown", {}, "unknown_legacy"],
  ];
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
    CREATE TABLE memory_items(item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,lifecycle TEXT NOT NULL,verification TEXT NOT NULL);
    CREATE TABLE memory_sources(source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE TABLE projection_outbox(outbox_id TEXT PRIMARY KEY,processed_at TEXT);`);
  for (const [id, metadata, classification] of rows) {
    db.prepare("INSERT INTO memory_truth VALUES (?,?)").run(id, JSON.stringify(metadata));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?)").run(`legacy:${id}`, `revision:${id}`, "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)")
      .run(`source:${id}`, `revision:${id}`, JSON.stringify({ classification }));
  }
  db.close();
  await chmod(source, 0o600);
  await writeFile(registry, JSON.stringify({
    [direct]: { sessionId: "direct-id", sessionFile: join(root, "direct-id.jsonl") },
    [group]: { sessionId: "group-id", sessionFile: join(root, "group-id.jsonl") },
  }), { mode: 0o600 });
  const baselineRows = rows.map(([id]) => ({ itemIdSha256: sha256(`legacy:${id}`) }));
  await writeFile(baseline, JSON.stringify({
    phase: "clawlore-phase7g-live-preview",
    candidatePromotionPlan: {
      planDigest: sha256(JSON.stringify(baselineRows)),
      rows: baselineRows,
      authorizesLiveMutation: false,
    },
  }), { mode: 0o600 });
  return { root, source, registry, baseline };
}

async function upgradeToCurrentBaseline(paths) {
  const db = new DatabaseSync(paths.source);
  db.exec(`CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_fts_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE memory_relation_projection_v2(item_id TEXT PRIMARY KEY);`);
  for (const row of db.prepare("SELECT item_id FROM memory_items").all()) {
    db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?)").run(row.item_id);
    db.prepare("INSERT INTO memory_fts_v2 VALUES (?)").run(row.item_id);
    db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?)").run(row.item_id);
    db.prepare("INSERT INTO memory_relation_projection_v2 VALUES (?)").run(row.item_id);
  }
  for (const [id, kind] of [["direct", "direct-principal"], ["group", "conversation-boundary"]]) {
    const row = db.prepare("SELECT evidence_json FROM memory_sources WHERE source_id=?").get(`source:${id}`);
    const evidence = JSON.parse(row.evidence_json);
    evidence.registryResolvedEvidenceV1 = { evidenceKind: kind };
    db.prepare("UPDATE memory_sources SET evidence_json=? WHERE source_id=?")
      .run(JSON.stringify(evidence), `source:${id}`);
  }
  const systemRow = db.prepare("SELECT evidence_json FROM memory_sources WHERE source_id='source:system'").get();
  const systemEvidence = JSON.parse(systemRow.evidence_json);
  systemEvidence.sourceLineageReceiptV1 = {
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
  db.prepare("UPDATE memory_sources SET evidence_json=? WHERE source_id='source:system'")
    .run(JSON.stringify(systemEvidence));
  db.close();
  const dispositions = {
    direct: "hold_candidate",
    group: "hold_candidate",
    manual: "hold_candidate",
    system: "hold_candidate",
    alias: "hold_candidate",
    opaque: "quarantine",
    unknown: "quarantine",
  };
  const baselineRows = Object.entries(dispositions).map(([id, disposition]) => ({
    itemIdSha256: sha256(`legacy:${id}`),
    disposition,
    reasonCodes: ["fixture"],
  }));
  await writeFile(paths.baseline, JSON.stringify({
    phase: "clawlore-post-assignment-candidate-plan",
    source: {
      v1Rows: 7,
      v2Rows: 7,
      candidateRows: 7,
      activeRows: 0,
      archivedRows: 0,
      compatibilityRows: 7,
      currentFtsRows: 7,
      vectorRows: 7,
      relationRows: 7,
      pendingOutboxRows: 0,
    },
    decision: { lifecycleRolloutSelectable: false, eligibleRows: 0 },
    candidatePromotionPlan: {
      planDigest: sha256(JSON.stringify(baselineRows)),
      rows: baselineRows,
      authorizesLiveMutation: false,
      automaticPromotionRows: 0,
    },
  }), { mode: 0o600 });
}

test("candidate evidence remediation creates a redacted query-only workbench", async () => {
  const paths = await fixture();
  try {
    const plan = createLiveCandidateEvidenceRemediationPlanV1({
      sourcePath: paths.source,
      sessionsRegistryPath: paths.registry,
      baselinePreviewPath: paths.baseline,
    });
    assert.equal(plan.source.candidateRows, 7);
    assert.equal(plan.counts.registry_private_assignment_review, 1);
    assert.equal(plan.counts.registry_conversation_assignment_review, 1);
    assert.equal(plan.counts.manual_principal_assignment_review, 1);
    assert.equal(plan.counts.derived_system_evidence_review, 1);
    assert.equal(plan.counts.source_lineage_content_review, 0);
    assert.equal(plan.counts.legacy_agent_alias_quarantine, 1);
    assert.equal(plan.counts.opaque_reference_quarantine, 1);
    assert.equal(plan.counts.unknown_legacy_quarantine, 1);
    assert.deepEqual(plan.summary, {
      assignmentReviewRows: 3,
      evidenceReviewRows: 1,
      quarantineRows: 3,
      mutationReadyRows: 0,
    });
    assert.equal(plan.authorizesLifecycleMutation, false);
    assert.equal(plan.automaticPromotionRows, 0);
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes("user-1"), false);
    assert.equal(serialized.includes("group-1"), false);
    assert.equal(serialized.includes("legacy:direct"), false);
    assert.equal(serialized.includes("do-not-emit-marker"), false);
    assert.equal(serialized.includes("auto-capture"), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("candidate evidence remediation fails closed when the baseline candidate set is stale", async () => {
  const paths = await fixture();
  try {
    const baseline = JSON.parse(await (await import("node:fs/promises")).readFile(paths.baseline, "utf8"));
    baseline.candidatePromotionPlan.rows.pop();
    await writeFile(paths.baseline, JSON.stringify(baseline), { mode: 0o600 });
    assert.throws(() => createLiveCandidateEvidenceRemediationPlanV1({
      sourcePath: paths.source,
      sessionsRegistryPath: paths.registry,
      baselinePreviewPath: paths.baseline,
    }), /baseline promotion preview contract is invalid|no longer matches baseline/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("candidate evidence remediation preserves the current hold/quarantine baseline", async () => {
  const paths = await fixture();
  try {
    await upgradeToCurrentBaseline(paths);
    const plan = createLiveCandidateEvidenceRemediationPlanV1({
      sourcePath: paths.source,
      sessionsRegistryPath: paths.registry,
      baselinePreviewPath: paths.baseline,
    });
    assert.equal(plan.baselinePhase, "clawlore-post-assignment-candidate-plan");
    assert.equal(plan.counts.assigned_private_evidence_review, 1);
    assert.equal(plan.counts.assigned_conversation_evidence_review, 1);
    assert.equal(plan.counts.manual_principal_assignment_review, 1);
    assert.equal(plan.counts.derived_system_evidence_review, 0);
    assert.equal(plan.counts.source_lineage_content_review, 1);
    assert.equal(plan.counts.legacy_provenance_hold_review, 1);
    assert.equal(plan.counts.opaque_reference_quarantine, 1);
    assert.equal(plan.counts.unknown_legacy_quarantine, 1);
    assert.deepEqual(plan.summary, {
      assignmentReviewRows: 1,
      evidenceReviewRows: 4,
      quarantineRows: 2,
      policyHoldRows: 5,
      policyQuarantineRows: 2,
      mutationReadyRows: 0,
    });
    assert.equal(plan.source.currentFtsRows, 7);
    assert.equal(plan.source.vectorRows, 7);
    assert.equal(plan.source.relationRows, 7);
    assert.equal(plan.authorizesLifecycleMutation, false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("candidate evidence remediation rejects current baseline projection drift", async () => {
  const paths = await fixture();
  try {
    await upgradeToCurrentBaseline(paths);
    const db = new DatabaseSync(paths.source);
    db.prepare("DELETE FROM memory_vector_projection_v2 WHERE item_id=?").run("legacy:direct");
    db.close();
    assert.throws(() => createLiveCandidateEvidenceRemediationPlanV1({
      sourcePath: paths.source,
      sessionsRegistryPath: paths.registry,
      baselinePreviewPath: paths.baseline,
    }), /live source no longer matches/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
