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
const {
  adaptLegacyAutoCaptureTriggerV2,
  adaptLegacyDigestTriggerV2,
  adaptLegacyReflectionTriggerV2,
  adaptLegacyTaskExperienceTriggerV2,
} = jiti("../src/v2/adapters/openclaw/legacy-distillation-triggers.ts");

function address() {
  return {
    schemaVersion: 2,
    tenantId: "local",
    principalId: "user-1",
    agentId: "main",
    conversationId: "dm-1",
    visibility: "private",
    retention: "durable",
  };
}

function clock() {
  let sequence = 0;
  return { now: () => new Date("2026-07-11T16:00:00.000Z"), id: () => `legacy-trigger-${++sequence}` };
}

test("four legacy automatic triggers enter one candidate journal and never write directly", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-legacy-triggers-"));
  const truth = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  try {
    truth.open();
    const journal = new InMemoryDistillationJournalV2();
    const extractor = {
      async extract(event) {
        const mapping = {
          auto_capture: { content: "User prefers compact technical answers", category: "preference", sourceRole: "user" },
          reflection: { content: "Verify service health after configuration changes", category: "procedure", sourceRole: "assistant" },
          digest: { content: "SQLite remains the runtime truth store", category: "decision", sourceRole: "assistant" },
          task_experience: { content: "Run read-back and health probes before reporting success", category: "procedure", sourceRole: "tool" },
        };
        return [{ ...mapping[event.trigger], confidence: 0.95 }];
      },
    };
    const pipeline = new UnifiedDistillationPipelineV2(truth, journal, extractor);
    const common = { address: address(), observedAt: "2026-07-11T16:00:00Z" };
    const events = [
      adaptLegacyAutoCaptureTriggerV2({
        ...common,
        sourceId: "session-1:turn-4",
        userMessages: ["Keep technical answers compact"],
      }),
      adaptLegacyReflectionTriggerV2({
        ...common,
        sourceId: "reflection-event-1",
        command: "/new",
        reflectionText: "Verify health after configuration changes",
        usedFallback: false,
      }),
      adaptLegacyDigestTriggerV2({
        ...common,
        sourceId: "digest-chunk-1",
        digestRunId: "digest-run-1",
        candidateText: "SQLite remains the truth store",
      }),
      adaptLegacyTaskExperienceTriggerV2({
        ...common,
        sourceId: "session-1",
        episodeId: "episode-1",
        userGoal: "Apply a safe configuration change",
        capsuleText: "Read back configuration and probe health",
        verified: true,
        toolReceiptIds: ["tool-receipt-1"],
      }),
    ];

    assert.equal(truth.count("memory_items"), 0);
    assert.equal(new Set(events.map((event) => event.eventId)).size, 4);
    for (const event of events) {
      assert.equal(event.forceCandidate, true);
      const receipt = await pipeline.process(event);
      assert.equal(receipt.trigger, event.trigger);
      assert.equal(receipt.admittedCount, 1);
    }
    assert.equal(truth.count("memory_items"), 4);
    assert.deepEqual(journal.receipts.map((receipt) => receipt.trigger), [
      "auto_capture",
      "reflection",
      "digest",
      "task_experience",
    ]);
    const records = journal.receipts.map((receipt) => truth.get(receipt.itemIds[0]));
    assert.equal(records.every((record) => record.lifecycle === "candidate"), true);
    assert.equal(records.find((record) => record.content.startsWith("Run read-back")).verification, "tool_verified");
    assert.equal(records.filter((record) => record.verification === "unverified").length, 3);

    const replay = await pipeline.process(events[0]);
    assert.deepEqual(replay.rejectionReasons, ["idempotent_event_already_processed"]);
    assert.equal(truth.count("memory_items"), 4);
  } finally {
    truth.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy trigger ids are deterministic and required provenance ids fail closed", () => {
  const input = {
    address: address(),
    observedAt: "2026-07-11T16:00:00Z",
    sourceId: "session-2:turn-1",
    userMessages: ["remember candidate"],
  };
  assert.equal(
    adaptLegacyAutoCaptureTriggerV2(input).eventId,
    adaptLegacyAutoCaptureTriggerV2(input).eventId,
  );
  assert.throws(
    () => adaptLegacyDigestTriggerV2({ ...input, sourceId: "", digestRunId: "run", candidateText: "candidate" }),
    /source id is required/,
  );
  assert.throws(
    () => adaptLegacyTaskExperienceTriggerV2({
      ...input,
      sourceId: "session-2",
      episodeId: "",
      userGoal: "goal",
      capsuleText: "capsule",
    }),
    /episode id is required/,
  );
});
