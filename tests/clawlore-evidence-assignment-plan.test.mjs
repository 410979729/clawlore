import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createLiveCandidateEvidenceRemediationPlanV1 } =
  jiti("../src/v2/operator/live-candidate-evidence-remediation.ts");
const { createLiveEvidenceAssignmentPlanV1 } =
  jiti("../src/v2/operator/live-evidence-assignment-plan.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-evidence-assignment-"));
  const source = join(root, "live.sqlite3");
  const registry = join(root, "sessions.json");
  const baseline = join(root, "baseline.json");
  const remediation = join(root, "remediation.json");
  const direct = "agent:main:telegram:default:direct:user-1";
  const group = "agent:main:telegram:group:group-1";
  const rows = [
    ["direct", { source: "auto-capture", sessionKey: direct }, "auto_capture", "unverified"],
    ["group", { source: "auto-capture", sessionKey: group }, "auto_capture", "unverified"],
    ["manual", { source: "manual", private_note: "do-not-emit-marker" }, "explicit_manual", "user_confirmed"],
    ["system", { source: "reflection-summary", source_session: "batch-1" }, "reflection_summary", "unverified"],
    ["alias", { source: "auto-capture", source_session: "agent:main:main" }, "auto_capture", "unverified"],
    ["opaque", { source: "auto-capture", source_session: "opaque" }, "auto_capture", "unverified"],
    ["unknown", {}, "unknown_legacy", "unverified"],
  ];
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
    CREATE TABLE memory_items(item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,lifecycle TEXT NOT NULL,verification TEXT NOT NULL,address_json TEXT NOT NULL);
    CREATE TABLE memory_sources(source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE TABLE projection_outbox(outbox_id TEXT PRIMARY KEY,processed_at TEXT);
    CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY);`);
  for (const [id, metadata, classification, verification] of rows) {
    db.prepare("INSERT INTO memory_truth VALUES (?,?)").run(id, JSON.stringify(metadata));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?)").run(
      `legacy:${id}`,
      `revision:${id}`,
      "candidate",
      verification,
      JSON.stringify({ visibility: "private", principalId: "legacy:unresolved" }),
    );
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)")
      .run(`source:${id}`, `revision:${id}`, JSON.stringify({ classification }));
    db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?)").run(`legacy:${id}`);
  }
  db.close();
  await chmod(source, 0o600);
  const registryValue = {
    [direct]: { sessionId: "direct-id", sessionFile: join(root, "direct-id.jsonl") },
    [group]: { sessionId: "group-id", sessionFile: join(root, "group-id.jsonl") },
  };
  await writeFile(registry, JSON.stringify(registryValue), { mode: 0o600 });
  await writeFile(baseline, JSON.stringify({
    phase: "clawlore-phase7g-live-preview",
    candidatePromotionPlan: {
      planDigest: sha256("baseline"),
      rows: rows.map(([id]) => ({ itemIdSha256: sha256(`legacy:${id}`) })),
      authorizesLiveMutation: false,
    },
  }), { mode: 0o600 });
  const remediationValue = createLiveCandidateEvidenceRemediationPlanV1({
    sourcePath: source,
    sessionsRegistryPath: registry,
    baselinePreviewPath: baseline,
  });
  await writeFile(remediation, JSON.stringify(remediationValue), { mode: 0o600 });
  return { root, source, registry, registryValue, baseline, remediation };
}

test("evidence assignment plan is exact, redacted, and non-authorizing", async () => {
  const paths = await fixture();
  try {
    const plan = createLiveEvidenceAssignmentPlanV1({
      sourcePath: paths.source,
      sessionsRegistryPath: paths.registry,
      remediationPreviewPath: paths.remediation,
      baselinePromotionPreviewPath: paths.baseline,
      proposedRolloutId: "clawlore-v2-evidence-assignment-fixture-r1",
    });
    assert.deepEqual(plan.summary, {
      proposedEvidenceAssignmentRows: 2,
      explicitHoldRows: 2,
      quarantineRows: 3,
      lifecycleRowsChanged: 0,
      verificationRowsChanged: 0,
    });
    assert.equal(plan.decisions.propose_private_principal_evidence_assignment, 1);
    assert.equal(plan.decisions.propose_conversation_boundary_evidence_assignment, 1);
    assert.equal(plan.decisions.keep_candidate_unassigned, 1);
    assert.equal(plan.decisions.await_external_source_receipt, 1);
    assert.equal(plan.decisions.retain_quarantine, 3);
    assert.equal(plan.authorizesEvidenceWrite, false);
    assert.equal(plan.authorizesLifecycleMutation, false);
    assert.equal(plan.automaticPromotionRows, 0);
    assert.equal(plan.rows.every((row) => row.postLifecycle === "candidate"), true);
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes("user-1"), false);
    assert.equal(serialized.includes("group-1"), false);
    assert.equal(serialized.includes("legacy:direct"), false);
    assert.equal(serialized.includes("do-not-emit-marker"), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("evidence assignment plan fails closed when registry evidence drifts", async () => {
  const paths = await fixture();
  try {
    const changed = { ...paths.registryValue };
    delete changed[Object.keys(changed)[0]];
    await writeFile(paths.registry, JSON.stringify(changed), { mode: 0o600 });
    assert.throws(() => createLiveEvidenceAssignmentPlanV1({
      sourcePath: paths.source,
      sessionsRegistryPath: paths.registry,
      remediationPreviewPath: paths.remediation,
      baselinePromotionPreviewPath: paths.baseline,
      proposedRolloutId: "clawlore-v2-evidence-assignment-fixture-r1",
    }), /no longer matches|rows no longer match/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("evidence assignment plan can bind a strict hashed target allowlist", async () => {
  const paths = await fixture();
  try {
    const target = sha256("legacy:direct");
    const plan = createLiveEvidenceAssignmentPlanV1({
      sourcePath: paths.source,
      sessionsRegistryPath: paths.registry,
      remediationPreviewPath: paths.remediation,
      baselinePromotionPreviewPath: paths.baseline,
      proposedRolloutId: "clawlore-v2-evidence-assignment-fixture-r2",
      targetItemSha256Allowlist: [target],
    });
    assert.deepEqual(plan.targetItemSha256Allowlist, [target]);
    assert.equal(plan.summary.proposedEvidenceAssignmentRows, 1);
    assert.equal(plan.summary.explicitHoldRows, 3);
    assert.equal(plan.rows.find((row) => row.itemIdSha256 === target)?.decision,
      "propose_private_principal_evidence_assignment");
    assert.equal(plan.decisions.propose_conversation_boundary_evidence_assignment, 0);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
