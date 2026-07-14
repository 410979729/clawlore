import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SqliteTruthStoreV2 } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const { previewLegacyMigrationV2 } = jiti("../src/v2/migration/legacy-v2-preview.ts");

function address() {
  return {
    schemaVersion: 2,
    tenantId: "local",
    principalId: "telegram:default:user-1",
    agentId: "main",
    workspaceId: "workspace-main",
    platform: "telegram",
    accountId: "default",
    conversationId: "user-1",
    visibility: "private",
    retention: "durable",
  };
}

function clock() {
  let sequence = 0;
  return {
    now: () => new Date("2026-07-11T10:00:00.000Z"),
    id: () => `id-${++sequence}`,
  };
}

test("Truth V2 remember/correct/archive commit revision, source, ACL, event, and outbox atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-truth-v2-"));
  const store = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    store.open();
    const remembered = store.remember({
      itemId: "memory-1",
      content: "The service port is 19021",
      category: "fact",
      address: address(),
      verification: "tool_verified",
      source: { sourceType: "tool", sourceId: "health-probe", observedAt: "2026-07-11T09:59:00Z" },
      actor: "agent:main",
      reason: "verified service fact",
    });
    assert.equal(remembered.outboxIds.length, 3);
    assert.equal(store.count("memory_items"), 1);
    assert.equal(store.count("memory_revisions"), 1);
    assert.equal(store.count("memory_sources"), 1);
    assert.equal(store.count("memory_acl"), 1);
    assert.equal(store.count("memory_events"), 1);
    assert.equal(store.count("projection_outbox"), 3);

    const corrected = store.correct({
      itemId: "memory-1",
      content: "The service port is 19022",
      verification: "user_confirmed",
      source: { sourceType: "user_message", sourceId: "message-2", observedAt: "2026-07-11T10:00:00Z" },
      actor: "principal:user-1",
      reason: "user correction",
    });
    assert.equal(corrected.previousRevisionId, remembered.revisionId);
    assert.equal(store.get("memory-1").content, "The service port is 19022");
    assert.equal(store.get("memory-1").revision, 2);
    assert.equal(store.count("memory_relations"), 1);
    assert.equal(store.listPendingOutbox().length, 6);

    const archived = store.forget({ itemId: "memory-1", actor: "principal:user-1", reason: "no longer needed" });
    assert.equal(archived.action, "archive");
    assert.equal(store.get("memory-1").lifecycle, "archived");
    assert.equal(store.count("memory_revisions"), 3);
    assert.equal(store.listPendingOutbox().length, 9);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Truth V2 rolls back partial writes and requires approval for purge", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-truth-v2-"));
  const store = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    store.open();
    const input = {
      itemId: "memory-duplicate",
      content: "one",
      category: "fact",
      address: address(),
      source: { sourceType: "user_message", observedAt: "2026-07-11T10:00:00Z" },
      actor: "principal:user-1",
      reason: "explicit remember",
    };
    store.remember(input);
    assert.throws(() => store.remember({ ...input, content: "two" }));
    assert.equal(store.count("memory_items"), 1);
    assert.equal(store.count("memory_revisions"), 1);
    assert.equal(store.count("memory_sources"), 1);
    assert.equal(store.count("projection_outbox"), 3);
    assert.throws(() => store.forget({
      itemId: "memory-duplicate", hardDelete: true, actor: "operator", reason: "test purge",
    }), /explicit approval/);
    const purged = store.forget({
      itemId: "memory-duplicate", hardDelete: true, approved: true,
      actor: "operator", reason: "approved purge",
    });
    assert.equal(purged.action, "purge");
    assert.equal(store.get("memory-duplicate"), null);
    assert.equal(store.count("memory_revisions"), 0);
    assert.equal(store.count("memory_sources"), 0);
    assert.equal(store.count("memory_acl"), 0);
    assert.equal(store.count("memory_events"), 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Truth V2 correction preserves candidate lifecycle and cannot restore archived memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-truth-lifecycle-"));
  const store = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    store.open();
    store.remember({
      itemId: "candidate-memory",
      content: "candidate content",
      category: "fact",
      address: address(),
      lifecycle: "candidate",
      verification: "unverified",
      source: { sourceType: "extractor", observedAt: "2026-07-11T10:00:00Z" },
      actor: "agent:main",
      reason: "fixture",
    });
    store.correct({
      itemId: "candidate-memory",
      content: "corrected candidate content",
      source: { sourceType: "user_message", observedAt: "2026-07-11T10:00:00Z" },
      actor: "principal:user-1",
      reason: "bounded correction",
    });
    assert.equal(store.get("candidate-memory").lifecycle, "candidate");

    store.forget({ itemId: "candidate-memory", actor: "principal:user-1", reason: "archive" });
    assert.throws(() => store.correct({
      itemId: "candidate-memory",
      content: "must not restore",
      source: { sourceType: "user_message", observedAt: "2026-07-11T10:00:00Z" },
      actor: "principal:user-1",
      reason: "correction without restore authority",
    }), /explicit restore/);
    assert.equal(store.get("candidate-memory").lifecycle, "archived");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy migration preview is read-only and preserves verification debt", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-legacy-preview-"));
  const path = join(root, "legacy.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE memory_truth (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO memory_truth(id,metadata) VALUES (?,?)");
    insert.run("manual", JSON.stringify({ source: "manual_user", verification: "user_confirmed" }));
    insert.run("capture", JSON.stringify({ source: "smart_extraction" }));
    insert.run("unknown", "not-json");
    db.close();
    const before = createHash("sha256").update(await readFile(path)).digest("hex");
    const preview = previewLegacyMigrationV2(path);
    const after = createHash("sha256").update(await readFile(path)).digest("hex");
    assert.equal(preview.readOnly, true);
    assert.equal(preview.totalRows, 3);
    assert.deepEqual(preview.classifications, { explicit_manual: 1, auto_capture: 1, unknown_legacy: 1 });
    assert.equal(preview.verificationDebt, 2);
    assert.equal(preview.invalidMetadataRows, 1);
    assert.deepEqual(preview.attributionLanes, {
      manual_operator_review: 1,
      unattributed_quarantine: 2,
    });
    assert.equal(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
