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
const {
  applyTruthSchemaHardeningV1,
  previewTruthSchemaHardeningV1,
} = jiti("../src/v2/operator/truth-schema-hardening.ts");

const LEGACY_SCHEMA = `
  CREATE TABLE clawlore_schema(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
  INSERT INTO clawlore_schema VALUES (2,'2026-07-14T00:00:00Z');
  CREATE TABLE memory_items(
    item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
    content TEXT NOT NULL,category TEXT NOT NULL,address_json TEXT NOT NULL,
    tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,agent_id TEXT NOT NULL,
    visibility TEXT NOT NULL,retention TEXT NOT NULL,workspace_id TEXT,project_id TEXT,
    conversation_id TEXT,thread_id TEXT,customer_id TEXT,task_id TEXT,
    lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  );
  CREATE TABLE memory_revisions(
    revision_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
    content TEXT NOT NULL,lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,
    created_at TEXT NOT NULL,UNIQUE(item_id,revision_no)
  );
  CREATE TABLE memory_sources(
    source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,source_type TEXT NOT NULL,
    external_id TEXT,observed_at TEXT NOT NULL,evidence_json TEXT NOT NULL
  );
  CREATE TABLE memory_acl(
    acl_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,
    visibility TEXT NOT NULL,policy_json TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TABLE memory_relations(
    relation_id TEXT PRIMARY KEY,from_revision_id TEXT NOT NULL,to_revision_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TABLE memory_events(
    event_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_id TEXT,event_type TEXT NOT NULL,
    actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TABLE projection_outbox(
    outbox_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_id TEXT,operation TEXT NOT NULL,
    projection TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL,
    created_at TEXT NOT NULL,processed_at TEXT,last_error TEXT
  );
`;

function seedLegacy(path, { orphanSource = false } = {}) {
  const db = new DatabaseSync(path);
  db.exec(LEGACY_SCHEMA);
  const now = "2026-07-14T00:00:00Z";
  const address = JSON.stringify({
    schemaVersion: 2,
    tenantId: "local",
    principalId: "user-1",
    agentId: "main",
    visibility: "private",
    retention: "durable",
  });
  db.prepare(`INSERT INTO memory_revisions VALUES
    ('revision-1','item-1',1,'content','candidate','unverified',NULL,?)`).run(now);
  db.prepare(`INSERT INTO memory_items VALUES
    ('item-1','revision-1',1,'content','fact',?,'local','user-1','main','private','durable',
      NULL,NULL,NULL,NULL,NULL,NULL,'candidate','unverified',NULL,?,?)`).run(address, now, now);
  db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)").run(
    "source-1",
    orphanSource ? "missing-revision" : "revision-1",
    "legacy",
    "legacy-1",
    now,
    "{}",
  );
  db.prepare("INSERT INTO memory_acl VALUES (?,?,?,?,?,?)").run(
    "acl-1", "item-1", "user-1", "private", "{}", now,
  );
  db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)").run(
    "event-1", "item-1", "revision-1", "remembered", "operator", "fixture", now,
  );
  db.prepare("INSERT INTO projection_outbox VALUES (?,?,?,?,?,0,?,?,?,NULL)").run(
    "outbox-1", "item-1", "revision-1", "upsert", "fts", now, now, now,
  );
  db.close();
}

test("schema hardening migrates exact rows and makes orphan checks enforceable", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-schema-hardening-"));
  const path = join(root, "truth.sqlite");
  try {
    seedLegacy(path);
    const plan = previewTruthSchemaHardeningV1(path);
    assert.equal(plan.status, "ready");
    assert.equal(plan.authorizesMutation, false);
    assert.equal(plan.currentSchemaVersion, 2);
    assert.equal(plan.foreignKeyCounts.memory_sources, 0);

    const receipt = applyTruthSchemaHardeningV1({
      path,
      expectedPlanDigest: plan.planDigest,
      now: () => new Date("2026-07-14T00:01:00Z"),
    });
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.targetSchemaVersion, 3);
    assert.equal(receipt.identityRows, 1);
    assert.equal(receipt.foreignKeyViolations, 0);
    assert.ok(receipt.foreignKeyCounts.memory_items >= 2);
    assert.ok(receipt.foreignKeyCounts.memory_relations >= 2);

    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    assert.throws(() => db.prepare("INSERT INTO memory_sources VALUES (?,?,?,?,?,?)").run(
      "orphan-source", "missing-revision", "legacy", null, "2026-07-14T00:02:00Z", "{}",
    ), /FOREIGN KEY/);
    assert.throws(() => db.prepare("INSERT INTO memory_events VALUES (?,?,?,?,?,?,?)").run(
      "orphan-event", "missing-item", null, "test", "operator", "fixture", "2026-07-14T00:02:00Z",
    ), /FOREIGN KEY/);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();

    const after = previewTruthSchemaHardeningV1(path);
    assert.equal(after.status, "already_hardened");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema hardening fails closed on orphaned legacy rows and stale plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-schema-hardening-blocked-"));
  const path = join(root, "truth.sqlite");
  try {
    seedLegacy(path, { orphanSource: true });
    const plan = previewTruthSchemaHardeningV1(path);
    assert.equal(plan.status, "blocked");
    assert.match(plan.blockers.join(","), /source_revision_missing:1/);
    assert.throws(() => applyTruthSchemaHardeningV1({
      path,
      expectedPlanDigest: "0".repeat(64),
    }), /digest is stale/);
    assert.throws(() => applyTruthSchemaHardeningV1({
      path,
      expectedPlanDigest: plan.planDigest,
    }), /is blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
