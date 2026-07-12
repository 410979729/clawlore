import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { buildReleaseReadinessReceipt } = jiti("../src/v2/application/release-readiness.ts");
const {
  InMemoryRuntimeShadowSinkV1,
  composeClawLoreRuntimeV1,
  normalizeClawLoreRuntimeConfigV1,
} = jiti("../src/v2/adapters/openclaw/runtime-composition-root.ts");

function evidence(overrides = {}) {
  return {
    focusedTests: true, fullTests: true, typecheck: true, build: true,
    moduleBoundaries: true, releaseGate: true, snapshotVerified: false,
    migrationDrill: false, rollbackDrill: false, legacyHashUnchanged: false,
    forbiddenScopeViolations: 0,
    ...overrides,
  };
}

function readiness() {
  return buildReleaseReadinessReceipt({
    rolloutId: "fixture-shadow-rollout",
    requestedMode: "shadow",
    currentMode: "disabled",
    evidence: evidence(),
    now: () => new Date("2026-07-12T03:00:00.000Z"),
  });
}

function approval(overrides = {}) {
  return {
    schemaVersion: 1,
    rolloutId: "fixture-shadow-rollout",
    mode: "shadow",
    decision: "approved",
    actor: "operator:fixture",
    approvedAt: "2026-07-12T03:01:00.000Z",
    ...overrides,
  };
}

function completeCapabilities() {
  return {
    ingest: true, assemble: true, afterTurn: true, maintain: true,
    compact: true, subagentLifecycle: true, tokenBudget: true, abortSignal: true,
  };
}

class FixtureHost {
  constructor(capabilities = completeCapabilities()) {
    this.capabilities = capabilities;
    this.hooks = [];
  }

  on(event, handler, options) {
    this.hooks.push({ event, handler, options });
  }

  async emitInboundClaim(event, context) {
    const results = [];
    for (const hook of this.hooks.filter((item) => item.event === "inbound_claim")) {
      results.push(await hook.handler(event, context));
    }
    return results;
  }
}

function dependencies(overrides = {}) {
  return {
    tenantId: "local",
    agentId: "main",
    workspaceId: "workspace-1",
    retrieveCandidates: async ({ boundary }) => [{
      id: "memory-1",
      section: "profile",
      text: "Use Simplified Chinese by default",
      targetAddress: {
        schemaVersion: 2,
        tenantId: boundary.tenantId,
        principalId: boundary.principalId,
        agentId: boundary.agentId,
        workspaceId: boundary.workspaceId,
        platform: boundary.platform,
        accountId: boundary.accountId,
        conversationId: boundary.conversationId,
        visibility: boundary.visibility,
        retention: "durable",
      },
      lifecycle: "active",
      verification: "user_confirmed",
      freshness: "current",
      score: 1,
      confidence: 1,
    }],
    ...overrides,
  };
}

test("runtime composition is default-off and invalid config fails to disabled", async () => {
  const manifest = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
  assert.equal(manifest.configSchema.properties.clawloreV2.properties.mode.default, "disabled");

  for (const config of [undefined, {}, { mode: "v2-write" }, { mode: "cutover" }]) {
    const host = new FixtureHost();
    const normalized = normalizeClawLoreRuntimeConfigV1(config);
    assert.equal(normalized.mode, "disabled");
    const receipt = composeClawLoreRuntimeV1({ config: normalized, host, dependencies: dependencies() });
    assert.equal(receipt.status, "disabled");
    assert.deepEqual(receipt.registeredHooks, []);
    assert.equal(receipt.toolRegistrations, 0);
    assert.equal(receipt.writeEnabled, false);
    assert.equal(receipt.contextEngineRegistered, false);
    assert.equal(host.hooks.length, 0);
  }
});

test("shadow request registers nothing without matching readiness and operator approval", () => {
  const config = normalizeClawLoreRuntimeConfigV1({ mode: "shadow" });

  const missing = new FixtureHost();
  const missingReceipt = composeClawLoreRuntimeV1({ config, host: missing, dependencies: dependencies() });
  assert.equal(missingReceipt.status, "blocked");
  assert.deepEqual(missingReceipt.blockingReasons, [
    "operator_approval_missing_or_invalid",
    "release_readiness_missing",
  ]);
  assert.equal(missing.hooks.length, 0);

  const mismatched = new FixtureHost();
  const mismatchReceipt = composeClawLoreRuntimeV1({
    config,
    host: mismatched,
    dependencies: dependencies(),
    readiness: readiness(),
    approval: approval({ rolloutId: "wrong-rollout" }),
  });
  assert.equal(mismatchReceipt.status, "blocked");
  assert.deepEqual(mismatchReceipt.blockingReasons, ["operator_approval_missing_or_invalid"]);
  assert.equal(mismatched.hooks.length, 0);
});

test("approved fixture shadow registers one observer and never mutates prompt or writes", async () => {
  const host = new FixtureHost();
  const sink = new InMemoryRuntimeShadowSinkV1();
  let retrievalCalls = 0;
  const receipt = composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({
      mode: "shadow",
      contextEngine: "compatibility",
      tokenBudget: 256,
    }),
    host,
    dependencies: dependencies({
      traceSink: sink,
      retrieveCandidates: async (request) => {
        retrievalCalls += 1;
        assert.equal(request.queryText, "private prompt must not enter the trace");
        return dependencies().retrieveCandidates(request);
      },
      now: () => new Date("2026-07-12T03:02:00.000Z"),
    }),
    readiness: readiness(),
    approval: approval(),
  });

  assert.equal(receipt.status, "registered");
  assert.deepEqual(receipt.registeredHooks, ["inbound_claim"]);
  assert.equal(receipt.contextEngine.selected, "compatibility");
  assert.equal(receipt.contextEngineRegistered, false);
  assert.equal(receipt.toolRegistrations, 0);
  assert.equal(receipt.writeEnabled, false);
  assert.equal(receipt.promptMutationEnabled, false);
  assert.equal(host.hooks.length, 1);
  assert.equal(host.hooks[0].options.priority, -100);

  const hookResults = await host.emitInboundClaim(
    {
      runId: "private-run-id",
      messageId: "raw-message-id",
      content: "private prompt must not enter the trace",
      channel: "telegram",
      accountId: "default",
      senderId: "joy-secret-id",
      conversationId: "joy-secret-id",
      isGroup: false,
    },
    {
      agentId: "main",
      sessionKey: "private-session-id",
      sessionId: "private-session-id",
      tokenBudget: 128,
    },
  );
  assert.deepEqual(hookResults, [{ handled: false }]);
  assert.equal(retrievalCalls, 1);
  assert.equal(sink.receipts.length, 1);
  assert.equal(sink.receipts[0].status, "completed");
  assert.equal(sink.receipts[0].selectedCount, 1);
  assert.equal(sink.receipts[0].retrievalInvoked, true);
  assert.match(sink.receipts[0].traceId, /^clawlore-shadow-[a-f0-9]{20}$/);
  const serialized = JSON.stringify(sink.receipts);
  assert.doesNotMatch(serialized, /joy-secret-id|private-session-id|private prompt|Simplified Chinese/);
});

test("trusted inbound claim preserves group sender and conversation boundaries", async () => {
  const host = new FixtureHost();
  const sink = new InMemoryRuntimeShadowSinkV1();
  let boundary;
  composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow" }),
    host,
    dependencies: dependencies({
      traceSink: sink,
      retrieveCandidates: async (request) => {
        boundary = request.boundary;
        return dependencies().retrieveCandidates(request);
      },
    }),
    readiness: readiness(),
    approval: approval(),
  });

  const results = await host.emitInboundClaim({
    runId: "group-run",
    messageId: "group-message",
    content: "group query",
    channel: "telegram",
    accountId: "default",
    senderId: "group-sender",
    conversationId: "group-conversation",
    threadId: "topic-7",
    isGroup: true,
  }, { agentId: "main", sessionKey: "group-session" });

  assert.deepEqual(results, [{ handled: false }]);
  assert.equal(boundary.principalId, "telegram:default:group-sender");
  assert.equal(boundary.visibility, "conversation");
  assert.equal(boundary.conversationId, "group-conversation");
  assert.equal(boundary.threadId, "topic-7");
  assert.equal(sink.receipts[0].retrievalInvoked, true);
});

test("native ContextEngine request remains blocked even when fixture host is capable", () => {
  const host = new FixtureHost();
  const receipt = composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow", contextEngine: "native-opt-in" }),
    host,
    dependencies: dependencies(),
    readiness: readiness(),
    approval: approval(),
  });
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.contextEngine.selected, "native-opt-in");
  assert.equal(receipt.contextEngineRegistered, false);
  assert.deepEqual(receipt.blockingReasons, ["native_context_engine_not_enabled_in_this_slice"]);
  assert.equal(host.hooks.length, 0);
});

test("shadow observer fails open when retrieval times out or trace persistence fails", async () => {
  const errors = [];
  const timeoutHost = new FixtureHost();
  composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow", maxLatencyMs: 25 }),
    host: timeoutHost,
    dependencies: dependencies({
      retrieveCandidates: async () => new Promise(() => undefined),
      onObserverError: (code) => errors.push(code),
    }),
    readiness: readiness(),
    approval: approval(),
  });
  const startedAt = Date.now();
  const timeoutResults = await timeoutHost.emitInboundClaim(
    {
      messageId: "timeout-message",
      content: "timeout retrieval query",
      channel: "telegram",
      senderId: "user-1",
      conversationId: "user-1",
      isGroup: false,
    },
    { agentId: "main" },
  );
  assert.deepEqual(timeoutResults, [{ handled: false }]);
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(errors, ["shadow_observer_timeout"]);

  const sinkHost = new FixtureHost();
  composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow" }),
    host: sinkHost,
    dependencies: dependencies({
      traceSink: { append: async () => { throw new Error("fixture sink failure"); } },
      onObserverError: (code) => errors.push(code),
    }),
    readiness: readiness(),
    approval: approval(),
  });
  const sinkResults = await sinkHost.emitInboundClaim(
    {
      messageId: "sink-message",
      content: "sink failure query",
      channel: "telegram",
      senderId: "user-1",
      conversationId: "user-1",
      isGroup: false,
    },
    { agentId: "main" },
  );
  assert.deepEqual(sinkResults, [{ handled: false }]);
  assert.deepEqual(errors, ["shadow_observer_timeout", "shadow_observer_failed"]);
});
