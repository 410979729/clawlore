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
const { createLiveV1AppendDeltaPlanV1 } = jiti("../src/v2/operator/live-v1-append-delta-plan.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-v1-append-delta-"));
  const source = join(root, "live.sqlite3");
  const baseline = join(root, "phase7n.json");
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(
      id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
      timestamp REAL NOT NULL,metadata TEXT NOT NULL,metadata_text TEXT NOT NULL);
    CREATE TABLE memory_items(
      item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,lifecycle TEXT NOT NULL,
      verification TEXT NOT NULL,address_json TEXT NOT NULL);
    CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY);
    CREATE TABLE projection_outbox(outbox_id TEXT PRIMARY KEY,processed_at TEXT);`);
  const insert = db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?)");
  insert.run("existing", "Existing mirrored truth", "fact", "agent:main", 1,
    JSON.stringify({ source: "smart_extraction" }), "existing");
  insert.run("delta-reflection", "Private reflection marker must not emit", "other", "agent:main", 2,
    JSON.stringify({ source: "reflection-summary", state: "active" }), "reflection");
  insert.run("delta-archived", "Archived marker must not emit", "other", "agent:main", 3,
    JSON.stringify({ source: "manual_user", state: "archived" }), "archived");
  db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?)").run(
    "legacy:existing",
    "revision:existing",
    "candidate",
    "unverified",
    JSON.stringify({
      schemaVersion: 2,
      tenantId: "local",
      principalId: "legacy:unresolved",
      agentId: "main",
      workspaceId: "workspace",
      visibility: "private",
      retention: "durable",
    }),
  );
  db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?)").run("legacy:existing");
  db.close();
  await chmod(source, 0o600);
  const baselineValue = {
    schemaVersion: 1,
    phase: "clawlore-post-assignment-candidate-plan",
    createdAt: "2026-07-12T15:00:00.000Z",
    proposedRolloutId: "clawlore-v2-candidate-promotion-fixture-r2",
    readOnly: true,
    queryOnly: true,
    emitsMemoryContent: false,
    emitsTranscriptContent: false,
    emitsRawIdentifiers: false,
    assignment: { rowsValidated: 1, invalidEvidenceRows: 0, unplannedEvidenceRows: 0 },
    source: {
      v1Rows: 1,
      v2Rows: 1,
      candidateRows: 1,
      activeRows: 0,
      archivedRows: 0,
      compatibilityRows: 1,
      pendingOutboxRows: 0,
      baselineV1Rows: 1,
      unmirroredV1Rows: 0,
      missingLegacyRowsForV2: 0,
      candidateBaselineUnchanged: true,
      sourceUnchangedDuringPlan: true,
    },
    candidatePromotionPlan: {
      planDigest: sha256("candidate-plan"),
      automaticPromotionRows: 0,
      authorizesLiveMutation: false,
      counts: { eligible_for_promotion: 0, hold_candidate: 1, quarantine: 0 },
    },
    decision: { eligibleRows: 0, lifecycleRolloutSelectable: false, automaticPromotionRows: 0 },
    authorizesLifecycleMutation: false,
    authorizesContextEngine: false,
    authorizesPromptMutation: false,
    authorizesFinalRecall: false,
    liveMutation: {
      evidenceRowsChanged: 0,
      lifecycleRowsChanged: 0,
      verificationRowsChanged: 0,
      addressRowsChanged: 0,
      contextEngineEnabled: false,
      promptMutationEnabled: false,
      finalRecallCutoverEnabled: false,
    },
  };
  await writeFile(baseline, `${JSON.stringify(baselineValue, null, 2)}\n`, { mode: 0o600 });
  return { root, source, baseline };
}

test("append-only V1 delta plan is redacted, complete, and non-authorizing", async () => {
  const paths = await fixture();
  try {
    const before = sha256(await readFile(paths.source));
    const plan = await createLiveV1AppendDeltaPlanV1({
      sourcePath: paths.source,
      baselineReceiptPath: paths.baseline,
      proposedRolloutId: "clawlore-v2-v1-delta-fixture-r1",
      defaults: { tenantId: "local", agentId: "main", workspaceId: "workspace" },
      now: () => new Date("2026-07-12T15:10:00.000Z"),
    });
    assert.equal(plan.source.v1Rows, 3);
    assert.equal(plan.source.v2Rows, 1);
    assert.equal(plan.source.deltaRows, 2);
    assert.equal(plan.proposed.activeRows, 0);
    assert.equal(plan.proposed.candidateRows, 1);
    assert.equal(plan.proposed.archivedRows, 1);
    assert.deepEqual(plan.proposed.classifications, { reflection_summary: 1, explicit_manual: 1 });
    assert.deepEqual(plan.proposed.verifications, { unverified: 1, user_confirmed: 1 });
    assert.equal(plan.proposed.reviewRequiredRows, 2);
    assert.equal(plan.projectionWork.outboxRows, 6);
    assert.equal(plan.decision.deltaWriteReady, true);
    assert.equal(plan.authorizesDeltaWrite, false);
    assert.equal(plan.authorizesFinalRecall, false);
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes("delta-reflection"), false);
    assert.equal(serialized.includes("Private reflection marker"), false);
    assert.equal(await sha256(await readFile(paths.source)), before);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("append-only V1 delta plan fails closed when a V2 item loses legacy backing", async () => {
  const paths = await fixture();
  try {
    const db = new DatabaseSync(paths.source);
    db.prepare("DELETE FROM memory_truth WHERE id='existing'").run();
    db.close();
    await assert.rejects(() => createLiveV1AppendDeltaPlanV1({
      sourcePath: paths.source,
      baselineReceiptPath: paths.baseline,
      proposedRolloutId: "clawlore-v2-v1-delta-fixture-r1",
      defaults: { tenantId: "local", agentId: "main", workspaceId: "workspace" },
    }), /no longer matches/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("append-only V1 delta plan rejects a group-readable baseline", async () => {
  const paths = await fixture();
  try {
    await chmod(paths.baseline, 0o640);
    await assert.rejects(() => createLiveV1AppendDeltaPlanV1({
      sourcePath: paths.source,
      baselineReceiptPath: paths.baseline,
      proposedRolloutId: "clawlore-v2-v1-delta-fixture-r1",
      defaults: { tenantId: "local", agentId: "main", workspaceId: "workspace" },
    }), /owner-only/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("append-only V1 delta plan accepts the policy-baseline zero-eligible field", async () => {
  const paths = await fixture();
  try {
    const baseline = JSON.parse(await readFile(paths.baseline, "utf8"));
    baseline.candidatePromotionPlan.counts = {
      eligible_for_operator_promotion: 0,
      hold_candidate: 1,
      quarantine: 0,
    };
    await writeFile(paths.baseline, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
    await chmod(paths.baseline, 0o600);
    const plan = await createLiveV1AppendDeltaPlanV1({
      sourcePath: paths.source,
      baselineReceiptPath: paths.baseline,
      proposedRolloutId: "clawlore-v2-v1-delta-fixture-r2",
      defaults: { tenantId: "local", agentId: "main", workspaceId: "workspace" },
    });
    assert.equal(plan.source.deltaRows, 2);
    assert.equal(plan.authorizesDeltaWrite, false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
