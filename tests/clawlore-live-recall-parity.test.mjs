import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { executeLiveV2WriteRolloutV1 } = jiti("../src/v2/operator/live-v2-write-rollout.ts");
const { inspectLiveV1V2RecallParityV1 } = jiti("../src/v2/eval/live-v1-v2-recall-parity.ts");
const { planLegacyMigrationV2 } = jiti("../src/v2/migration/legacy-v2-migration.ts");
const { inspectLegacySqliteSnapshotV2 } = jiti("../src/v2/operator/legacy-v1-snapshot.ts");
const { writeFile, chmod } = await import("node:fs/promises");

async function control(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

test("read-only parity proves corpus/ranking while enforcing stricter V2 policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-parity-"));
  const source = join(root, "memory.sqlite3");
  const readiness = join(root, "readiness.json");
  const approval = join(root, "approval.json");
  const rolloutId = "fixture-parity";
  const defaults = { tenantId: "local", agentId: "main", workspaceId: "workspace-main" };
  try {
    const db = new DatabaseSync(source);
    db.exec(`CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0,timestamp REAL NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',metadata_text TEXT NOT NULL DEFAULT '',updated_at REAL NOT NULL DEFAULT 0
    ); CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED,text,metadata_text);`);
    const insert = db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?,?,?)");
    const fts = db.prepare("INSERT INTO memory_truth_fts VALUES (?,?,?)");
    const rows = [
      ["joy", " Telegram memory boundary ", "fact", "agent:main", 1, 1700000000, { source: "manual_user", sender_id: "joy", platform: "telegram" }],
      ["other", "Telegram private boundary", "fact", "agent:main", 1, 1699999999, { source: "manual_user", sender_id: "other", platform: "telegram" }],
      ["archived", "Telegram obsolete boundary", "fact", "agent:main", 1, 1699999998, { source: "manual_user", sender_id: "joy", platform: "telegram", state: "archived" }],
    ];
    for (const row of rows) {
      const metadata = JSON.stringify(row[6]);
      insert.run(...row.slice(0, 6), metadata, "", row[5]);
      fts.run(row[0], row[1], "");
    }
    db.close();
    const snapshot = await inspectLegacySqliteSnapshotV2(source);
    const plan = planLegacyMigrationV2({ legacyPath: source, defaults });
    await control(readiness, {
      schemaVersion: 1, status: "ready", compatibilityValid: true, authorizesV2Writes: false,
      operatorApprovalPresent: false, writeActivationAllowed: false, manualDisposition: "candidate",
      rollout: { rolloutId, requestedMode: "v2-write", currentMode: "shadow", ready: true, readOnly: false,
        requiresOperatorApproval: true, blockingReasons: [] },
      evidenceBindings: { migrationPlanDigest: plan.planDigest,
        memoryTruthLogicalDigest: snapshot.memoryTruth.logicalDigest, memoryTruthRows: snapshot.memoryTruth.rowCount },
    });
    await control(approval, { schemaVersion: 1, rolloutId, mode: "v2-write", decision: "approved",
      actor: "operator:test", approvedAt: "2026-07-12T00:00:00.000Z", preserveV1Fallback: true,
      allowContextEngine: false, allowFinalRecallCutover: false });
    await executeLiveV2WriteRolloutV1({ sourcePath: source, readinessPath: readiness, approvalPath: approval,
      rolloutId, defaults, expectedV1VectorRows: 3 });
    const report = inspectLiveV1V2RecallParityV1({ sqlitePath: source, queries: [{
      queryText: "Telegram boundary", legacyScopes: ["agent:main"],
      actor: { tenantId: "local", principalId: "telegram:default:joy", agentId: "main", workspaceId: "workspace-main" },
      limit: 10,
    }] });
    assert.equal(report.sourceUnchanged, true);
    assert.equal(report.emitsMemoryContent, false);
    assert.deepEqual(report.corpus, {
      v1Rows: 3, v2Rows: 3, missingV2Rows: 0, duplicateLegacyMappings: 0,
      contentNormalizationOnlyRows: 1, substantiveContentMismatches: 0,
      categoryMismatches: 0, v1FtsRows: 3, v2FtsRows: 3,
      vectorFallbackRows: 3, invalidVectorFallbackRows: 0, active: 2, candidate: 0, archived: 1,
    });
    assert.equal(report.queries[0].commonLaneTopKOverlap, 1);
    assert.equal(report.queries[0].commonLaneRankAgreement, 1);
    assert.equal(report.queries[0].v1WouldExposeOutsideV2Policy, 1);
    assert.equal(report.queries[0].v2PolicyEligible, 1);
    assert.equal(report.queries[0].v2Injectable, 1);
    assert.equal(report.queries[0].v2ForbiddenScopeLeakage, 0);
    assert.equal(report.decision.shadowReadReady, true);
    assert.equal(report.decision.cutoverReady, true);
    assert.deepEqual(report.decision.shadowBlockers, []);
    assert.deepEqual(report.decision.cutoverBlockers, []);
    assert.equal("queryText" in report.queries[0], false);
    assert.equal(JSON.stringify(report).includes("Telegram memory boundary"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate-only V2 corpus can pass shadow parity but never cut over", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-candidate-parity-"));
  const source = join(root, "memory.sqlite3");
  try {
    const db = new DatabaseSync(source);
    db.exec(`CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0,timestamp REAL NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',metadata_text TEXT NOT NULL DEFAULT '',updated_at REAL NOT NULL DEFAULT 0
    ); CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED,text,metadata_text);
    CREATE TABLE memory_items (item_id TEXT PRIMARY KEY,current_revision_id TEXT,content TEXT,category TEXT,
      address_json TEXT,lifecycle TEXT,verification TEXT);
    CREATE TABLE memory_sources (revision_id TEXT,source_type TEXT,external_id TEXT,observed_at TEXT);
    CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(item_id UNINDEXED,content,category);
    CREATE TABLE memory_vector_projection_v2 (item_id TEXT PRIMARY KEY,legacy_id TEXT,backend TEXT,state TEXT);`);
    const address = JSON.stringify({ schemaVersion: 2, tenantId: "local", principalId: "legacy:unresolved",
      agentId: "main", workspaceId: "workspace-main", visibility: "private", retention: "durable" });
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?,?,?)")
      .run("candidate", "Memory candidate", "fact", "agent:main", 1, 1700000000, "{}", "", 1700000000);
    db.prepare("INSERT INTO memory_truth_fts VALUES (?,?,?)").run("candidate", "Memory candidate", "");
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?,?)")
      .run("legacy:candidate", "rev", "Memory candidate", "fact", address, "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?)")
      .run("rev", "legacy", "candidate", "2023-11-14T22:13:20.000Z");
    db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)").run("legacy:candidate", "Memory candidate", "fact");
    db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?)")
      .run("legacy:candidate", "candidate", "v1-lancedb-fallback", "fallback_verified");
    db.close();
    const report = inspectLiveV1V2RecallParityV1({ sqlitePath: source, queries: [{
      queryText: "Memory", legacyScopes: ["agent:main"],
      actor: { tenantId: "local", principalId: "telegram:default:joy", agentId: "main", workspaceId: "workspace-main" },
    }] });
    assert.equal(report.decision.shadowReadReady, true);
    assert.deepEqual(report.decision.shadowBlockers, []);
    assert.equal(report.decision.cutoverReady, false);
    assert.ok(report.decision.cutoverBlockers.includes("no_active_v2_memory"));
    assert.ok(report.decision.cutoverBlockers.includes("no_injectable_v2_recall_evidence"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
