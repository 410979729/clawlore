import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  buildPersistedSecretRemediationPlan,
  executePersistedSecretRemediation,
} = jiti("../src/v2/operator/persisted-secret-remediation.ts");
const { TRUTH_V2_SCHEMA_SQL } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const { findSecret } = jiti("../src/secret-redaction.ts");

class FakeVectorPort {
  constructor(rows) { this.rows = rows; }
  async scanRows(consume) {
    const rows = this.rows.map((row) => ({ ...row }));
    await consume(rows);
    return { scannedRows: rows.length, truncated: false };
  }
  async existingIds(ids) {
    const requested = new Set(ids);
    return this.rows.filter((row) => requested.has(row.id)).map((row) => row.id).sort();
  }
  async deleteIds(ids) {
    const planned = new Set(ids);
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !planned.has(row.id));
    return before - this.rows.length;
  }
}

class PartiallyFailingVectorPort extends FakeVectorPort {
  async deleteIds(ids) {
    await super.deleteIds(ids);
    throw new Error("synthetic vector failure after mutation");
  }
}

test("persisted-secret remediation is digest-bound, snapshot-gated, and converges across stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-secret-remediation-"));
  const memoryDbPath = join(root, "memory.sqlite3");
  const conversationDbPath = join(root, "conversation.sqlite3");
  const vectorPath = join(root, "vectors");
  const artifactPath = join(root, "artifacts");
  const secret = "SyntheticProviderCredentialValue123456";
  try {
    const memory = new DatabaseSync(memoryDbPath);
    memory.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE memory_truth(id TEXT PRIMARY KEY,text TEXT,metadata TEXT,metadata_text TEXT);
      CREATE VIRTUAL TABLE memory_truth_fts USING fts5(memory_id UNINDEXED,text,metadata_text);
      CREATE TABLE task_episodes(id TEXT PRIMARY KEY,evidence TEXT);
      ${TRUTH_V2_SCHEMA_SQL}
      CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(item_id UNINDEXED,content,category);
      CREATE VIRTUAL TABLE memory_fts_compat_v2 USING fts5(item_id UNINDEXED,content,metadata_text);
      CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY,legacy_id TEXT);
      CREATE TABLE memory_relation_projection_v2(item_id TEXT PRIMARY KEY,state TEXT);
    `);
    const unsafeText = `${secret} 这是BRAVE的API`;
    memory.prepare("INSERT INTO memory_truth VALUES(?,?,?,?)")
      .run("legacy-one", unsafeText, "{}", "");
    memory.prepare("INSERT INTO memory_truth_fts VALUES(?,?,?)")
      .run("legacy-one", unsafeText, "");
    memory.exec("BEGIN");
    memory.prepare("INSERT INTO memory_item_identities VALUES(?,?,NULL)")
      .run("legacy:legacy-one", "2026-07-22T00:00:00Z");
    memory.prepare(`INSERT INTO memory_revisions
      (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
      VALUES(?,?,?,?,?,?,NULL,?)`).run(
      "revision-one", "legacy:legacy-one", 1, unsafeText, "active", "unverified", "2026-07-22T00:00:00Z",
    );
    memory.prepare(`INSERT INTO memory_items
      (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
       visibility,retention,lifecycle,verification,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "legacy:legacy-one", "revision-one", 1, unsafeText, "fact", "{}", "tenant", "principal",
      "agent", "private", "durable", "active", "unverified", "2026-07-22T00:00:00Z", "2026-07-22T00:00:00Z",
    );
    memory.exec("COMMIT");
    memory.prepare("INSERT INTO memory_fts_v2 VALUES(?,?,?)")
      .run("legacy:legacy-one", unsafeText, "fact");
    memory.prepare("INSERT INTO memory_fts_v2 VALUES(?,?,?)")
      .run("orphan-secret-row", unsafeText, "fact");
    memory.prepare("INSERT INTO memory_fts_compat_v2 VALUES(?,?,?)")
      .run("legacy:legacy-one", unsafeText, "");
    memory.prepare("INSERT INTO memory_vector_projection_v2 VALUES(?,?)")
      .run("legacy:legacy-one", "legacy-one");
    memory.prepare("INSERT INTO memory_relation_projection_v2 VALUES(?,?)")
      .run("legacy:legacy-one", "ready");
    memory.prepare("INSERT INTO task_episodes VALUES(?,?)")
      .run("episode-one", JSON.stringify({ note: `Authorization: Bearer ${"A".repeat(32)}` }));
    memory.close();

    const conversation = new DatabaseSync(conversationDbPath);
    conversation.exec("CREATE TABLE conversations(id INTEGER PRIMARY KEY,detail TEXT)");
    conversation.prepare("INSERT INTO conversations(detail) VALUES(?)")
      .run(`password=${secret}`);
    conversation.close();
    await chmod(memoryDbPath, 0o600);
    await chmod(conversationDbPath, 0o640);

    const vector = new FakeVectorPort([{ id: "legacy-one", text: unsafeText, metadata: "{}" }]);
    await mkdir(vectorPath, { mode: 0o755 });
    await mkdir(artifactPath, { mode: 0o700 });
    await writeFile(
      join(artifactPath, "history.jsonl"),
      "{\"summary\":\"No credential values are persisted in this fixture.\"}\n",
      { mode: 0o600 },
    );
    const incomplete = await buildPersistedSecretRemediationPlan({
      memoryDbPath,
      conversationDbPath,
      vectorPath,
      vector,
    });
    assert.equal(incomplete.receipt.status, "blocked");
    assert.ok(incomplete.receipt.blockers.includes("persisted_artifact_roots_not_supplied"));

    const input = {
      memoryDbPath,
      conversationDbPath,
      vectorPath,
      vector,
      artifactRoots: [artifactPath],
    };
    const plan = await buildPersistedSecretRemediationPlan(input);
    assert.equal(plan.receipt.status, "ready");
    assert.equal(plan.receipt.artifactCoverage.complete, true);
    assert.equal(plan.receipt.preAudit.artifactFields, 0);
    assert.deepEqual(plan.receipt.targets, {
      v1MemoryItems: 1,
      v2MemoryItems: 2,
      vectorItems: 1,
      redactionRows: 2,
      redactionFields: 2,
    });
    assert.match(plan.receipt.targetIdentityDigest, /^[a-f0-9]{64}$/);
    assert.equal(plan.receipt.permissionFixRequired, true);
    assert.equal(JSON.stringify(plan.receipt).includes(secret), false);

    await assert.rejects(
      executePersistedSecretRemediation({
        ...input,
        expectedPlanDigest: plan.receipt.planDigest,
        approved: true,
        snapshotsVerified: true,
        vectorSnapshotVerified: false,
        credentialsRotated: true,
        tightenPermissions: true,
      }),
      /verified encrypted vector snapshot/,
    );

    await assert.rejects(
      executePersistedSecretRemediation({
        ...input,
        expectedPlanDigest: plan.receipt.planDigest,
        approved: true,
        snapshotsVerified: true,
        vectorSnapshotVerified: true,
        credentialsRotated: false,
        tightenPermissions: true,
      }),
      /credential rotation first/,
    );

    const failingVector = new PartiallyFailingVectorPort(vector.rows);
    await assert.rejects(
      executePersistedSecretRemediation({
        ...input,
        vector: failingVector,
        expectedPlanDigest: plan.receipt.planDigest,
        approved: true,
        snapshotsVerified: true,
        vectorSnapshotVerified: true,
        credentialsRotated: true,
        tightenPermissions: true,
      }),
      (error) => error?.code === "CLAWLORE_PERSISTED_SECRET_REMEDIATION_RECOVERY_REQUIRED"
        && error?.rollbackRequired === true,
    );
    const rolledBackMemory = new DatabaseSync(memoryDbPath, { readOnly: true });
    assert.equal(rolledBackMemory.prepare("SELECT COUNT(*) AS count FROM memory_truth").get().count, 1);
    assert.equal(rolledBackMemory.prepare("SELECT COUNT(*) AS count FROM memory_items").get().count, 1);
    rolledBackMemory.close();
    const rolledBackConversation = new DatabaseSync(conversationDbPath, { readOnly: true });
    assert.notEqual(findSecret(String(
      rolledBackConversation.prepare("SELECT detail FROM conversations").get().detail,
    )), null);
    rolledBackConversation.close();

    const receipt = await executePersistedSecretRemediation({
      ...input,
      expectedPlanDigest: plan.receipt.planDigest,
      approved: true,
      snapshotsVerified: true,
      vectorSnapshotVerified: true,
      credentialsRotated: true,
      tightenPermissions: true,
      now: () => new Date("2026-07-22T01:00:00Z"),
    });
    assert.equal(receipt.status, "pass");
    assert.deepEqual(receipt.postAudit, {
      memoryFields: 0,
      conversationFields: 0,
      vectorFields: 0,
      artifactFields: 0,
      artifactCoverageComplete: true,
    });
    assert.equal(vector.rows.length, 0);
    const verifyMemory = new DatabaseSync(memoryDbPath, { readOnly: true });
    assert.equal(verifyMemory.prepare("SELECT COUNT(*) AS count FROM memory_truth").get().count, 0);
    assert.equal(verifyMemory.prepare("SELECT COUNT(*) AS count FROM memory_items").get().count, 0);
    assert.equal(verifyMemory.prepare("SELECT COUNT(*) AS count FROM memory_events").get().count, 1);
    const evidence = String(verifyMemory.prepare("SELECT evidence FROM task_episodes").get().evidence);
    assert.equal(findSecret(evidence), null);
    verifyMemory.close();
    const verifyConversation = new DatabaseSync(conversationDbPath, { readOnly: true });
    assert.equal(findSecret(String(verifyConversation.prepare("SELECT detail FROM conversations").get().detail)), null);
    verifyConversation.close();
    if (process.platform !== "win32") {
      assert.equal((await stat(conversationDbPath)).mode & 0o077, 0);
      assert.equal((await stat(vectorPath)).mode & 0o077, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
