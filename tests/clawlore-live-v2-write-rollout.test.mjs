import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { executeLiveV2WriteRolloutV1 } = jiti("../src/v2/operator/live-v2-write-rollout.ts");
const { planLegacyMigrationV2 } = jiti("../src/v2/migration/legacy-v2-migration.ts");
const { inspectLegacySqliteSnapshotV2 } = jiti("../src/v2/operator/legacy-v1-snapshot.ts");

async function privateControl(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture(root) {
  const sourcePath = join(root, "live.sqlite3");
  const readinessPath = join(root, "readiness.json");
  const approvalPath = join(root, "approval.json");
  const defaults = { tenantId: "local", agentId: "main", workspaceId: "workspace-main" };
  const db = new DatabaseSync(sourcePath);
  db.exec(`CREATE TABLE memory_truth (
    id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
    timestamp REAL NOT NULL DEFAULT 0,metadata TEXT NOT NULL DEFAULT '{}'
  )`);
  const insert = db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?)");
  insert.run("manual", "Manual candidate", "preference", "agent:main", 1_700_000_000,
    JSON.stringify({ source: "manual_user" }));
  insert.run("capture", "Automatic candidate", "fact", "agent:main", 1_700_000_001,
    JSON.stringify({ source: "smart_extraction" }));
  insert.run("archived", "Archived fact", "fact", "agent:main", 1_700_000_002,
    JSON.stringify({ source: "manual_user", state: "archived" }));
  db.close();
  const manifest = await inspectLegacySqliteSnapshotV2(sourcePath);
  const plan = planLegacyMigrationV2({ legacyPath: sourcePath, defaults });
  await privateControl(readinessPath, {
    schemaVersion: 1,
    status: "ready",
    compatibilityValid: true,
    rollout: {
      rolloutId: "fixture-rollout-r1",
      requestedMode: "v2-write",
      currentMode: "shadow",
      ready: true,
      readOnly: false,
      requiresOperatorApproval: true,
      blockingReasons: [],
    },
    authorizesV2Writes: false,
    operatorApprovalPresent: false,
    writeActivationAllowed: false,
    manualDisposition: "candidate",
    evidenceBindings: {
      migrationPlanDigest: plan.planDigest,
      memoryTruthRows: manifest.memoryTruth.rowCount,
      memoryTruthLogicalDigest: manifest.memoryTruth.logicalDigest,
    },
  });
  await privateControl(approvalPath, {
    schemaVersion: 1,
    rolloutId: "fixture-rollout-r1",
    mode: "v2-write",
    decision: "approved",
    actor: "operator:fixture",
    approvedAt: "2026-07-12T10:00:00.000Z",
    preserveV1Fallback: true,
    allowContextEngine: false,
    allowFinalRecallCutover: false,
  });
  return { sourcePath, readinessPath, approvalPath, defaults, manifest };
}

test("approved live rollout applies V2 atomically while preserving V1 fallback and boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-live-v2-write-"));
  try {
    const input = await fixture(root);
    const beforeBytes = await readFile(input.sourcePath);
    const receipt = await executeLiveV2WriteRolloutV1({
      sourcePath: input.sourcePath,
      readinessPath: input.readinessPath,
      approvalPath: input.approvalPath,
      rolloutId: "fixture-rollout-r1",
      defaults: input.defaults,
      expectedV1VectorRows: 3,
      now: () => new Date("2026-07-12T10:01:00.000Z"),
    });
    assert.equal(receipt.status, "applied");
    assert.deepEqual(receipt.v2, {
      items: 3,
      active: 0,
      candidate: 2,
      archived: 1,
      ftsRows: 3,
      vectorFallbackRows: 3,
      relationProjectionRows: 3,
      relationRows: 0,
      outboxProcessed: 9,
      outboxPending: 0,
      experienceTables: 5,
      experienceRows: 0,
    });
    assert.deepEqual(receipt.runtime, {
      v1FallbackReads: true,
      contextEngineEnabled: false,
      finalRecallCutoverEnabled: false,
    });
    const after = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    assert.equal(after.memoryTruth.logicalDigest, input.manifest.memoryTruth.logicalDigest);
    assert.notEqual(createHash("sha256").update(beforeBytes).digest("hex"), createHash("sha256").update(await readFile(input.sourcePath)).digest("hex"));
    await assert.rejects(() => executeLiveV2WriteRolloutV1({
      sourcePath: input.sourcePath,
      readinessPath: input.readinessPath,
      approvalPath: input.approvalPath,
      rolloutId: "fixture-rollout-r1",
      defaults: input.defaults,
      expectedV1VectorRows: 3,
    }), /schema already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live rollout rejects incomplete V1 vector fallback before creating V2 tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-live-v2-vector-gate-"));
  try {
    const input = await fixture(root);
    await assert.rejects(() => executeLiveV2WriteRolloutV1({
      sourcePath: input.sourcePath,
      readinessPath: input.readinessPath,
      approvalPath: input.approvalPath,
      rolloutId: "fixture-rollout-r1",
      defaults: input.defaults,
      expectedV1VectorRows: 2,
    }), /fallback is not fully converged/);
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name='memory_items'").get().count, 0);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
