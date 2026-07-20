import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { SqliteTruthStoreV2 } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const { InMemoryDistillationJournalV2, UnifiedDistillationPipelineV2 } = jiti("../src/v2/application/distillation-pipeline.ts");
const { ProjectionWorkerV2 } = jiti("../src/v2/workers/projection-worker.ts");

function address() {
  return {
    schemaVersion: 2, tenantId: "local", principalId: "user-1", agentId: "main",
    conversationId: "dm-1", visibility: "private", retention: "durable",
  };
}

function clock() {
  let sequence = 0;
  return { now: () => new Date("2026-07-11T11:00:00.000Z"), id: () => `distill-${++sequence}` };
}

test("unified distillation admits explicit/tool truth, gates inference, rejects secrets, and deduplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-distill-"));
  const truth = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    truth.open();
    if (process.platform !== "win32") {
      assert.equal((await stat(root)).mode & 0o077, 0);
      assert.equal((await stat(join(root, "truth.sqlite"))).mode & 0o077, 0);
    }
    const journal = new InMemoryDistillationJournalV2();
    const proposals = [
      { content: "Use Chinese by default", category: "preference", confidence: 0.99, sourceRole: "user" },
      { content: "Use Chinese by default", category: "preference", confidence: 0.99, sourceRole: "user" },
      { content: "api_key=super-secret-value", category: "fact", confidence: 0.99, sourceRole: "user" },
      { content: '{"databasePassword":"synthetic-distillation-value"}', category: "fact", confidence: 0.99, sourceRole: "user" },
      { content: "serviceToken: |\n  synthetic multiline distillation value", category: "fact", confidence: 0.99, sourceRole: "user" },
      { content: "The assistant guessed a future preference", category: "preference", confidence: 0.8, sourceRole: "assistant" },
    ];
    const pipeline = new UnifiedDistillationPipelineV2(truth, journal, { extract: async () => proposals });
    const receipt = await pipeline.process({
      eventId: "turn-1", address: address(), userText: "remember preference",
      assistantText: "ok", explicitRemember: true, observedAt: "2026-07-11T11:00:00Z",
    });
    assert.equal(receipt.proposalCount, 6);
    assert.equal(receipt.admittedCount, 2);
    assert.equal(receipt.duplicateCount, 1);
    assert.equal(receipt.rejectedCount, 3);
    assert.deepEqual(receipt.rejectionReasons, ["secret_shaped_content"]);
    const records = receipt.itemIds.map((id) => truth.get(id));
    assert.equal(records.find((item) => item.content === "Use Chinese by default").lifecycle, "active");
    assert.equal(records.find((item) => item.content.includes("assistant guessed")).lifecycle, "candidate");
    assert.equal(truth.count("memory_items"), 2);

    const replay = await pipeline.process({
      eventId: "turn-1", address: address(), userText: "remember preference",
      explicitRemember: true, observedAt: "2026-07-11T11:00:00Z",
    });
    assert.deepEqual(replay.rejectionReasons, ["idempotent_event_already_processed"]);
    assert.equal(truth.count("memory_items"), 2);
  } finally {
    truth.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("distillation sanitizes provider input and V2 truth rejects unsafe direct persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-distill-safety-"));
  const truth = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    truth.open();
    const seen = [];
    const journal = new InMemoryDistillationJournalV2();
    const pipeline = new UnifiedDistillationPipelineV2(truth, journal, {
      async extract(event) {
        seen.push(event);
        return [
          { content: "Remember concise technical answers", category: "preference", confidence: 0.99, sourceRole: "user" },
          { content: "Private key lives at /home/a/.ssh/id_ed25519", category: "fact", confidence: 0.99, sourceRole: "assistant" },
        ];
      },
    });
    const receipt = await pipeline.process({
      eventId: "turn-safe-provider", address: address(),
      userText: "[Image attached at: /tmp/credential-screenshot.png]\nRemember concise technical answers",
      assistantText: "ok", explicitRemember: true, observedAt: "2026-07-11T11:00:00Z",
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].userText, "Remember concise technical answers");
    assert.equal(seen[0].assistantText, undefined);
    assert.equal(JSON.stringify(seen[0]).includes("credential-screenshot"), false);
    assert.equal(receipt.admittedCount, 1);
    assert.equal(receipt.rejectedCount, 1);
    assert.deepEqual(receipt.rejectionReasons, ["capture_unsafe_content"]);

    let extractorCalls = 0;
    const blocked = new UnifiedDistillationPipelineV2(truth, new InMemoryDistillationJournalV2(), {
      async extract() { extractorCalls += 1; return []; },
    });
    await assert.rejects(() => blocked.process({
      eventId: "turn-private-path", address: address(),
      userText: "Read /home/a/.ssh/id_ed25519 before continuing",
      observedAt: "2026-07-11T11:00:00Z",
    }), /safety policy/);
    assert.equal(extractorCalls, 0);

    const directInput = {
      category: "fact", address: address(), verification: "tool_verified",
      source: { sourceType: "tool", observedAt: "2026-07-11T11:00:00Z" },
      actor: "agent:main", reason: "direct persistence safety test",
    };
    assert.throws(() => truth.remember({
      ...directInput,
      content: "[Image attached at: /tmp/private-token-image.png]\nDurable fact",
    }), /safety policy/);
    assert.throws(() => truth.remember({
      ...directInput,
      content: "Private key lives at /home/a/.ssh/id_ed25519",
    }), /safety policy/);
    assert.throws(() => truth.remember({
      ...directInput,
      content: "Ordinary durable fact",
      source: {
        sourceType: "tool", observedAt: "2026-07-11T11:00:00Z",
        evidence: { receipt: "Read /home/a/.ssh/id_ed25519" },
      },
    }), /safety policy/);
    assert.throws(() => truth.remember({
      ...directInput,
      content: "Ordinary durable fact",
      address: { ...address(), principalId: "/home/a/.ssh/id_ed25519" },
    }), /safety policy/);
  } finally {
    truth.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("projection failure preserves SQL truth and converges on retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-projector-"));
  const truth = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    truth.open();
    const remembered = truth.remember({
      itemId: "memory-projection", content: "verified fact", category: "fact", address: address(),
      verification: "tool_verified", source: { sourceType: "tool", observedAt: "2026-07-11T11:00:00Z" },
      actor: "agent:main", reason: "projection test",
    });
    let failVector = true;
    const calls = [];
    const worker = new ProjectionWorkerV2(truth, ["fts", "vector", "relations"].map((projection) => ({
      projection,
      async apply(row, memory) {
        calls.push(`${projection}:${row.operation}`);
        assert.equal(memory.itemId, remembered.itemId);
        if (projection === "vector" && failVector) { failVector = false; throw new Error("temporary"); }
      },
    })));
    const first = await worker.run();
    assert.equal(first.processed, 2);
    assert.equal(first.failed, 1);
    assert.equal(truth.get(remembered.itemId).content, "verified fact");
    assert.equal(truth.listPendingOutbox().length, 1);
    const second = await worker.run();
    assert.equal(second.processed, 1);
    assert.equal(second.failed, 0);
    assert.equal(truth.listPendingOutbox().length, 0);
    assert.equal(calls.filter((item) => item.startsWith("vector:")).length, 2);
  } finally {
    truth.close();
    await rm(root, { recursive: true, force: true });
  }
});
