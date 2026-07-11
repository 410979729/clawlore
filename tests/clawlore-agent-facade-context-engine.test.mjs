import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentMemoryFacadeV2, CLAWLORE_AGENT_ACTIONS } = jiti("../src/v2/application/agent-memory-facade.ts");
const { SqliteTruthStoreV2 } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const {
  ClawLoreContextEngineSkeletonV2,
  negotiateContextEngineV2,
} = jiti("../src/v2/adapters/openclaw/context-engine-skeleton.ts");

function address(overrides = {}) {
  return {
    schemaVersion: 2,
    tenantId: "local",
    principalId: "user-1",
    agentId: "main",
    conversationId: "chat-1",
    threadId: "thread-1",
    projectId: "project-1",
    visibility: "private",
    retention: "durable",
    ...overrides,
  };
}

function clock() {
  let sequence = 0;
  return {
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    id: () => `facade-${++sequence}`,
  };
}

function completeHost(overrides = {}) {
  return {
    ingest: true,
    assemble: true,
    afterTurn: true,
    maintain: true,
    compact: true,
    subagentLifecycle: true,
    tokenBudget: true,
    abortSignal: true,
    ...overrides,
  };
}

test("Agent facade exposes four core actions and filters before returning memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-agent-facade-"));
  const store = new SqliteTruthStoreV2(join(root, "truth.sqlite"), clock());
  const actor = address();
  try {
    store.open();
    const facade = new AgentMemoryFacadeV2(store);
    assert.deepEqual(CLAWLORE_AGENT_ACTIONS, [
      "memory_query", "memory_remember", "memory_correct", "memory_forget",
    ]);

    const remembered = facade.remember({
      actor,
      content: "Preferred language is Chinese",
      category: "preference",
      sourceId: "message-1",
      observedAt: "2026-07-11T11:59:00Z",
    });
    store.remember({
      itemId: "other-private",
      content: "Preferred language is French",
      category: "preference",
      address: address({ principalId: "user-2" }),
      source: { sourceType: "user_message", observedAt: "2026-07-11T11:59:00Z" },
      actor: "principal:user-2",
      reason: "fixture",
    });
    store.remember({
      itemId: "other-thread",
      content: "Preferred language is German",
      category: "preference",
      address: address({ visibility: "conversation", principalId: "user-2", threadId: "thread-2" }),
      source: { sourceType: "user_message", observedAt: "2026-07-11T11:59:00Z" },
      actor: "principal:user-2",
      reason: "fixture",
    });
    store.remember({
      itemId: "other-project",
      content: "Preferred language is Spanish",
      category: "preference",
      address: address({ visibility: "project", principalId: "user-2", projectId: "project-2" }),
      source: { sourceType: "user_message", observedAt: "2026-07-11T11:59:00Z" },
      actor: "principal:user-2",
      reason: "fixture",
    });
    store.remember({
      itemId: "expired",
      content: "Preferred language is Japanese",
      category: "preference",
      address: actor,
      validUntil: "2026-07-11T11:00:00Z",
      source: { sourceType: "user_message", observedAt: "2026-07-11T10:00:00Z" },
      actor: "principal:user-1",
      reason: "fixture",
    });
    store.remember({
      itemId: "global-without-grant",
      content: "Preferred language is Italian",
      category: "preference",
      address: address({ visibility: "global", principalId: "operator" }),
      source: { sourceType: "operator", observedAt: "2026-07-11T11:59:00Z" },
      actor: "operator",
      reason: "fixture",
    });

    assert.deepEqual(facade.query(actor, "Preferred language").map((item) => item.itemId), [remembered.itemId]);
    assert.deepEqual(facade.query(address({ principalId: "" }), "Preferred language"), []);

    const corrected = facade.correct({
      actor,
      itemId: remembered.itemId,
      content: "Preferred language is Simplified Chinese",
      sourceId: "message-2",
      observedAt: "2026-07-11T12:00:00Z",
    });
    assert.equal(corrected.action, "correct");
    assert.throws(() => facade.correct({
      actor: address({ principalId: "user-2" }),
      itemId: remembered.itemId,
      content: "unauthorized",
      observedAt: "2026-07-11T12:00:00Z",
    }), /not accessible/);

    const forgotten = facade.forget({ actor, itemId: remembered.itemId, reason: "user request" });
    assert.equal(forgotten.action, "archive");
    assert.deepEqual(facade.query(actor, "Preferred language"), []);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ContextEngine remains compatibility-first and fails closed on missing host capabilities", () => {
  const compatibility = negotiateContextEngineV2({ requested: "compatibility", host: completeHost() });
  assert.equal(compatibility.selected, "compatibility");
  assert.equal(compatibility.canActivateNative, true);
  assert.throws(
    () => new ClawLoreContextEngineSkeletonV2(compatibility).assertNativeActivationAllowed(),
    /activation denied/,
  );

  const degraded = negotiateContextEngineV2({
    requested: "native-opt-in",
    host: completeHost({ abortSignal: false, subagentLifecycle: false }),
  });
  assert.equal(degraded.selected, "compatibility");
  assert.deepEqual(degraded.missingCapabilities, ["subagentLifecycle", "abortSignal"]);
  assert.equal(degraded.reason, "native_capability_negotiation_failed");

  const native = negotiateContextEngineV2({ requested: "native-opt-in", host: completeHost() });
  assert.equal(native.selected, "native-opt-in");
  assert.equal(native.canActivateNative, true);
  assert.doesNotThrow(() => new ClawLoreContextEngineSkeletonV2(native).assertNativeActivationAllowed());
});
