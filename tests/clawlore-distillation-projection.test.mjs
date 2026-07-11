import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    const journal = new InMemoryDistillationJournalV2();
    const proposals = [
      { content: "Use Chinese by default", category: "preference", confidence: 0.99, sourceRole: "user" },
      { content: "Use Chinese by default", category: "preference", confidence: 0.99, sourceRole: "user" },
      { content: "api_key=super-secret-value", category: "fact", confidence: 0.99, sourceRole: "user" },
      { content: "The assistant guessed a future preference", category: "preference", confidence: 0.8, sourceRole: "assistant" },
    ];
    const pipeline = new UnifiedDistillationPipelineV2(truth, journal, { extract: async () => proposals });
    const receipt = await pipeline.process({
      eventId: "turn-1", address: address(), userText: "remember preference",
      assistantText: "ok", explicitRemember: true, observedAt: "2026-07-11T11:00:00Z",
    });
    assert.equal(receipt.proposalCount, 4);
    assert.equal(receipt.admittedCount, 2);
    assert.equal(receipt.duplicateCount, 1);
    assert.equal(receipt.rejectedCount, 1);
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
