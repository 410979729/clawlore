import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolvePrincipalWriteTarget } = jiti("../src/principal-write-boundary.ts");
const { createLivePrincipalScopePlanV1 } = jiti("../src/v2/operator/live-principal-scope-plan.ts");

function createFixture(path, targetSessionKey) {
  const targetScope = resolvePrincipalWriteTarget({ sessionKey: targetSessionKey }).scope;
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
      importance REAL NOT NULL,timestamp REAL NOT NULL,metadata TEXT NOT NULL,
      metadata_text TEXT NOT NULL,updated_at REAL NOT NULL
    );
    CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED,text,metadata_text);
    CREATE TABLE memory_lifecycle_projection (
      memory_id TEXT PRIMARY KEY,scope TEXT NOT NULL,truth_updated_at REAL NOT NULL
    );
    CREATE TABLE memory_items (
      item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,address_json TEXT NOT NULL,
      principal_id TEXT NOT NULL,visibility TEXT NOT NULL,lifecycle TEXT NOT NULL,
      verification TEXT NOT NULL
    );
    CREATE TABLE memory_acl (
      acl_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,
      visibility TEXT NOT NULL,policy_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE memory_sources (
      source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,evidence_json TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`INSERT INTO memory_truth
    (id,text,category,scope,importance,timestamp,metadata,metadata_text,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertFts = db.prepare("INSERT INTO memory_truth_fts(memory_id,text,metadata_text) VALUES (?,?,?)");
  const insertLifecycle = db.prepare(`INSERT INTO memory_lifecycle_projection
    (memory_id,scope,truth_updated_at) VALUES (?,?,?)`);
  function truth(id, scope, metadata, content = `private-content-${id}`) {
    const encoded = typeof metadata === "string" ? metadata : JSON.stringify(metadata);
    insert.run(id, content, "fact", scope, 0.8, 1_700_000_000_000, encoded, encoded, 1234);
    insertFts.run(id, content, encoded);
    insertLifecycle.run(id, scope, 1234);
  }
  function mirror(id, principalId = "legacy:unresolved") {
    const itemId = `legacy:${id}`;
    const revisionId = `revision:${id}`;
    db.prepare(`INSERT INTO memory_items
      (item_id,current_revision_id,address_json,principal_id,visibility,lifecycle,verification)
      VALUES (?,?,?,?,?,?,?)`).run(
      itemId,
      revisionId,
      JSON.stringify({
        schemaVersion: 2,tenantId: "local",principalId,agentId: "main",
        visibility: "private",retention: "durable",
      }),
      principalId,
      "private",
      "candidate",
      "unverified",
    );
    db.prepare(`INSERT INTO memory_acl
      (acl_id,item_id,owner_principal_id,visibility,policy_json,created_at)
      VALUES (?,?,?,?,?,?)`).run(`acl:${id}`, itemId, principalId, "private", "{}", "2026-07-22T00:00:00.000Z");
    db.prepare("INSERT INTO memory_sources(source_id,revision_id,evidence_json) VALUES (?,?,?)")
      .run(`source:${id}`, revisionId, "{}");
  }

  truth("target-mirrored", "agent:main", { sessionKey: targetSessionKey });
  mirror("target-mirrored");
  truth("target-unmirrored", "agent:main", { source_session: targetSessionKey });
  truth("target-already", targetScope, { session_key: targetSessionKey });
  mirror("target-already", "telegram:default:owner");
  truth("other-private", "agent:main", { sessionKey: "agent:main:telegram:default:direct:other" });
  truth("conversation", "agent:main", { sessionKey: "agent:main:telegram:default:group:team" });
  truth("system", "agent:main", { source: "nightly_digest", sessionId: "opaque-uuid" });
  truth("manual", "agent:main", { source: "manual" });
  truth("opaque", "agent:main", { sessionId: "opaque-session" });
  truth("none", "agent:main", {});
  truth("invalid", "agent:main", "not-json");
  return { db, targetScope, mirror };
}

test("principal-scope plan isolates exact private evidence and fails closed on missing V2 mirrors", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-principal-plan-"));
  const sourcePath = join(root, "memory.sqlite3");
  const targetSessionKey = "agent:main:telegram:default:direct:owner";
  const { db, targetScope, mirror } = createFixture(sourcePath, targetSessionKey);
  db.close();
  try {
    const input = {
      sourcePath,
      targetSessionKey,
      sourceScope: "agent:main",
      proposedMigrationId: "principal-scope-owner-r1",
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    };
    const blocked = await createLivePrincipalScopePlanV1(input);
    assert.equal(blocked.source.memoryTruthRows, 10);
    assert.equal(blocked.summary.targetEvidenceRows, 3);
    assert.equal(blocked.summary.principalAssignmentRows, 3);
    assert.equal(blocked.summary.migrationEligibleRows, 2);
    assert.equal(blocked.summary.alreadyAssignedRows, 1);
    assert.equal(blocked.summary.v2MirroredAssignmentRows, 2);
    assert.equal(blocked.summary.unmirroredAssignmentRows, 1);
    assert.equal(blocked.decision.assignmentReady, false);
    assert.equal(blocked.target.scope, targetScope);
    assert.equal(blocked.lanes.other_private_session, 1);
    assert.equal(blocked.lanes.conversation_session, 1);
    assert.equal(blocked.lanes.derived_system_reference, 1);
    assert.equal(blocked.lanes.manual_unattributed, 1);
    assert.equal(blocked.lanes.opaque_session_reference, 1);
    assert.equal(blocked.lanes.no_identity_reference, 1);
    assert.equal(blocked.lanes.invalid_metadata, 1);

    const serialized = JSON.stringify(blocked);
    assert.doesNotMatch(serialized, /private-content/);
    assert.doesNotMatch(serialized, /target-mirrored/);
    assert.doesNotMatch(serialized, new RegExp(targetSessionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const writable = new DatabaseSync(sourcePath);
    const reopened = {
      db: writable,
      mirror: (id, principalId = "legacy:unresolved") => {
        const itemId = `legacy:${id}`;
        const revisionId = `revision:${id}`;
        writable.prepare(`INSERT INTO memory_items
          (item_id,current_revision_id,address_json,principal_id,visibility,lifecycle,verification)
          VALUES (?,?,?,?,?,?,?)`).run(itemId, revisionId, JSON.stringify({
            schemaVersion: 2,tenantId: "local",principalId,agentId: "main",
            visibility: "private",retention: "durable",
          }), principalId, "private", "candidate", "unverified");
        writable.prepare(`INSERT INTO memory_acl
          (acl_id,item_id,owner_principal_id,visibility,policy_json,created_at)
          VALUES (?,?,?,?,?,?)`).run(`acl:${id}`, itemId, principalId, "private", "{}", "2026-07-22T00:00:00.000Z");
        writable.prepare("INSERT INTO memory_sources(source_id,revision_id,evidence_json) VALUES (?,?,?)")
          .run(`source:${id}`, revisionId, "{}");
      },
    };
    reopened.mirror("target-unmirrored");
    reopened.db.close();

    const ready = await createLivePrincipalScopePlanV1(input);
    assert.equal(ready.summary.unmirroredAssignmentRows, 0);
    assert.equal(ready.summary.v2MirroredAssignmentRows, 3);
    assert.equal(ready.decision.assignmentReady, true);
    const repeated = await createLivePrincipalScopePlanV1(input);
    assert.equal(repeated.planDigest, ready.planDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
