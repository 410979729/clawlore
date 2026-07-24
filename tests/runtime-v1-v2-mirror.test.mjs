import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { TRUTH_V2_SCHEMA_SQL } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const { mirrorRuntimeV1WriteToV2 } = jiti("../src/v2/storage/runtime-v1-v2-mirror.ts");
const { inspectRuntimeV2CutoverPreflightV1 } =
  jiti("../src/v2/operator/runtime-cutover-preflight.ts");
const { createNativeShadowCandidateRetrieverV1 } =
  jiti("../src/adapters/openclaw/native-shadow-retrieval.ts");

test("V1 manual write mirror commits V2 truth and local projections atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-runtime-mirror-"));
  const path = join(root, "memory.sqlite3");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(TRUTH_V2_SCHEMA_SQL);
    db.exec(`
      CREATE TABLE memory_truth (
        id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
        importance REAL NOT NULL,timestamp REAL NOT NULL,metadata TEXT NOT NULL,
        metadata_text TEXT NOT NULL,updated_at REAL NOT NULL
      );
      CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(item_id UNINDEXED,content,category);
      CREATE TABLE memory_vector_projection_v2 (
        item_id TEXT PRIMARY KEY,legacy_id TEXT NOT NULL,backend TEXT NOT NULL,state TEXT NOT NULL,verified_at TEXT
      );
      CREATE TABLE memory_relation_projection_v2 (
        item_id TEXT PRIMARY KEY,state TEXT NOT NULL,verified_at TEXT
      );
    `);
    db.prepare(`INSERT INTO memory_truth
      (id,text,category,scope,importance,timestamp,metadata,metadata_text,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      "11111111-1111-4111-8111-111111111111",
      "SILVER ORBIT production canary",
      "fact",
      "user:fixture",
      0.7,
      Date.parse("2026-07-23T18:00:00.000Z"),
      "{}",
      "",
      Date.parse("2026-07-23T18:00:00.000Z"),
    );
  } finally {
    db.close();
  }
  const address = {
    schemaVersion: 2,
    tenantId: "local",
    principalId: "telegram:default:8176453077",
    agentId: "main",
    platform: "telegram",
    accountId: "default",
    visibility: "private",
    retention: "durable",
  };
  const first = mirrorRuntimeV1WriteToV2(path, {
    legacyId: "11111111-1111-4111-8111-111111111111",
    content: "SILVER ORBIT production canary",
    category: "fact",
    address,
    observedAt: "2026-07-23T18:00:00.000Z",
    actor: "agent:main",
  });
  assert.equal(first.status, "mirrored");
  assert.equal(first.projectionStatus, "converged");
  assert.equal(mirrorRuntimeV1WriteToV2(path, {
    legacyId: "11111111-1111-4111-8111-111111111111",
    content: "SILVER ORBIT production canary",
    category: "fact",
    address,
    observedAt: "2026-07-23T18:00:00.000Z",
    actor: "agent:main",
  }).status, "already_mirrored");

  const retrieve = createNativeShadowCandidateRetrieverV1({
    sqlitePath: path,
    candidateLimit: 6,
  });
  const candidates = await retrieve({
    boundary: {
      tenantId: "local",
      principalId: "telegram:default:8176453077",
      agentId: "main",
      platform: "telegram",
      accountId: "default",
      visibility: "private",
    },
    queryText: "SILVER ORBIT",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, "SILVER ORBIT production canary");
  assert.equal(candidates[0].lifecycle, "active");
  assert.equal(candidates[0].verification, "user_confirmed");

  const verify = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM projection_outbox WHERE processed_at IS NULL").get().n, 0);
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM projection_outbox").get().n, 3);
    assert.equal(verify.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(verify.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    verify.close();
  }
  const preflight = inspectRuntimeV2CutoverPreflightV1(path);
  assert.equal(preflight.cutoverReady, true);
  assert.equal(preflight.v1RetirementReady, true);
  assert.deepEqual(preflight.blockers, []);

  const archiveCheck = new DatabaseSync(path);
  try {
    archiveCheck.prepare("UPDATE memory_items SET lifecycle='archived' WHERE item_id=?")
      .run(first.itemId);
  } finally {
    archiveCheck.close();
  }
  const archivedPreflight = inspectRuntimeV2CutoverPreflightV1(path);
  assert.equal(
    archivedPreflight.blockers.includes("current_fts_projection_mismatch"),
    false,
    "archived current revisions intentionally retain FTS projections",
  );
  await rm(root, { recursive: true, force: true });
});
