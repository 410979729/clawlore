import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createNativeShadowCandidateRetrieverV1 } = jiti(
  "../src/v2/adapters/openclaw/native-shadow-retrieval.ts",
);

function address(overrides = {}) {
  return {
    schemaVersion: 2,
    tenantId: "local",
    principalId: "telegram:default:joy",
    agentId: "main",
    workspaceId: "workspace-1",
    platform: "telegram",
    accountId: "default",
    visibility: "private",
    retention: "durable",
    ...overrides,
  };
}

test("native shadow reads V2 truth and excludes cross-boundary candidates before composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-native-shadow-"));
  const sqlitePath = join(root, "memory.sqlite3");
  try {
    const db = new DatabaseSync(sqlitePath);
    db.exec(`CREATE TABLE memory_items(
      item_id TEXT PRIMARY KEY,content TEXT,category TEXT,address_json TEXT,lifecycle TEXT,verification TEXT,
      valid_until TEXT,updated_at TEXT,tenant_id TEXT,principal_id TEXT,agent_id TEXT,visibility TEXT,
      conversation_id TEXT,thread_id TEXT,project_id TEXT
    );
    CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(item_id UNINDEXED,content,category);
    CREATE TABLE memory_vector_projection_v2(
      item_id TEXT PRIMARY KEY,legacy_id TEXT,backend TEXT,state TEXT,verified_at TEXT
    );`);
    const insert = db.prepare("INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const fts = db.prepare("INSERT INTO memory_fts_v2 VALUES (?,?,?)");
    const vector = db.prepare("INSERT INTO memory_vector_projection_v2 VALUES (?,?,?,?,?)");
    const now = "2026-07-14T12:00:00.000Z";
    const rows = [
      ["legacy:private", "V2 authoritative boundary memory", "fact", address(), "active", "user_confirmed"],
      ["legacy:thread", "V2 current thread boundary memory", "decision", address({ visibility: "conversation", conversationId: "room-1", threadId: "topic-1" }), "candidate", "unverified"],
      ["legacy:other-principal", "V2 other principal boundary memory", "fact", address({ principalId: "telegram:default:other" }), "active", "user_confirmed"],
      ["legacy:other-thread", "V2 other thread boundary memory", "fact", address({ visibility: "conversation", conversationId: "room-1", threadId: "topic-2" }), "active", "user_confirmed"],
      ["legacy:other-project", "V2 other project boundary memory", "fact", address({ visibility: "project", projectId: "project-2" }), "active", "user_confirmed"],
    ];
    for (const [itemId, content, category, itemAddress, lifecycle, verification] of rows) {
      insert.run(itemId, content, category, JSON.stringify(itemAddress), lifecycle, verification,
        null, now, itemAddress.tenantId, itemAddress.principalId, itemAddress.agentId,
        itemAddress.visibility, itemAddress.conversationId ?? null, itemAddress.threadId ?? null,
        itemAddress.projectId ?? null);
      fts.run(itemId, content, category);
      vector.run(itemId, itemId.slice("legacy:".length), "v1-lancedb-fallback", "fallback_verified", now);
    }
    db.close();

    let vectorCalls = 0;
    const retrieve = createNativeShadowCandidateRetrieverV1({
      sqlitePath,
      candidateLimit: 10,
      async retrieveVectorCandidates({ request, signal }) {
        vectorCalls += 1;
        assert.equal(request.queryText, "boundary memory");
        assert.equal(signal?.aborted, false);
        return rows.map((row, index) => ({ legacyId: row[0].slice("legacy:".length), score: 1 - index / 10 }));
      },
    });
    const controller = new AbortController();
    const candidates = await retrieve({
      queryText: "boundary memory",
      signal: controller.signal,
      boundary: {
        tenantId: "local",
        principalId: "telegram:default:joy",
        agentId: "main",
        workspaceId: "workspace-1",
        platform: "telegram",
        accountId: "default",
        conversationId: "room-1",
        threadId: "topic-1",
        projectId: "project-1",
        visibility: "conversation",
      },
    });
    assert.equal(vectorCalls, 1);
    assert.deepEqual(candidates.map((item) => item.id).sort(), ["legacy:private", "legacy:thread"]);
    assert.equal(candidates.find((item) => item.id === "legacy:private").text, "V2 authoritative boundary memory");
    assert.equal(candidates.find((item) => item.id === "legacy:thread").lifecycle, "candidate");
    assert.equal(candidates.some((item) => /other principal|other thread|other project/.test(item.text)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native shadow propagates cancellation to the vector lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-native-abort-"));
  const sqlitePath = join(root, "memory.sqlite3");
  try {
    const db = new DatabaseSync(sqlitePath);
    db.exec(`CREATE TABLE memory_items(
      item_id TEXT PRIMARY KEY,content TEXT,category TEXT,address_json TEXT,lifecycle TEXT,verification TEXT,
      valid_until TEXT,updated_at TEXT,tenant_id TEXT,principal_id TEXT,agent_id TEXT,visibility TEXT,
      conversation_id TEXT,thread_id TEXT,project_id TEXT
    ); CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(item_id UNINDEXED,content,category);
    CREATE TABLE memory_vector_projection_v2(item_id TEXT PRIMARY KEY,legacy_id TEXT,backend TEXT,state TEXT,verified_at TEXT);`);
    db.close();
    const controller = new AbortController();
    let observedAbort = false;
    const retrieve = createNativeShadowCandidateRetrieverV1({
      sqlitePath,
      candidateLimit: 2,
      retrieveVectorCandidates: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }),
    });
    const pending = retrieve({
      queryText: "abort query",
      signal: controller.signal,
      boundary: { tenantId: "local", principalId: "joy", agentId: "main", visibility: "private" },
    });
    controller.abort();
    await assert.rejects(pending, /aborted/i);
    assert.equal(observedAbort, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
