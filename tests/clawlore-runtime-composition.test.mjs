import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { releaseProvenance } from "./fixtures/release-provenance.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { resolveClawLoreRuntimeRequestConfig } = jiti("../src/runtime-config.ts");
const { buildReleaseReadinessReceipt } = jiti("../src/v2/application/release-readiness.ts");
const {
  InMemoryRuntimeShadowSinkV1,
  composeClawLoreRuntimeV1,
  normalizeClawLoreRuntimeConfigV1,
} = jiti("../src/v2/adapters/openclaw/runtime-composition-root.ts");
const {
  createClawLoreNativeContextEngineV1,
} = jiti("../src/adapters/openclaw/native-context-engine.ts");

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
    provenance: releaseProvenance(),
    now: () => new Date("2026-07-12T03:00:00.000Z"),
  });
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

  async emitMessageReceived(event, context) {
    const results = [];
    for (const hook of this.hooks.filter((item) => item.event === "message_received")) {
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
  assert.equal(manifest.configSchema.properties.runtime.properties.mode.default, "disabled");
  assert.match(
    manifest.configSchema.properties.runtime.properties.approvalFile.description,
    /Deprecated compatibility field.*ignored/,
  );
  assert.equal(manifest.configSchema.properties.runtime.properties.maxConcurrent.default, 2);
  assert.match(
    manifest.configSchema.properties.clawloreV2.description,
    /Deprecated compatibility alias for runtime/,
  );
  assert.equal(normalizeClawLoreRuntimeConfigV1({ mode: "shadow" }).maxConcurrent, 2);

  for (const config of [undefined, {}]) {
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
  assert.equal(normalizeClawLoreRuntimeConfigV1({ mode: "v2-write" }).mode, "v2-write");
  assert.equal(normalizeClawLoreRuntimeConfigV1({ mode: "cutover" }).mode, "cutover");
});

test("runtime config accepts the deprecated alias but rejects ambiguous dual input", () => {
  const requested = { mode: "shadow", contextEngine: "compatibility", maxConcurrent: 4 };
  const canonical = resolveClawLoreRuntimeRequestConfig({ runtime: requested });
  const legacy = resolveClawLoreRuntimeRequestConfig({ clawloreV2: requested });

  assert.deepEqual(canonical, legacy);
  assert.deepEqual(resolveClawLoreRuntimeRequestConfig({ runtime: requested, clawloreV2: requested }), canonical);
  assert.throws(
    () => resolveClawLoreRuntimeRequestConfig({
      runtime: requested,
      clawloreV2: { ...requested, maxConcurrent: 3 },
    }),
    /Conflicting ClawLore runtime and deprecated clawloreV2 configuration/,
  );
  assert.throws(
    () => resolveClawLoreRuntimeRequestConfig({ runtime: "shadow" }),
    /runtime configuration must be an object/,
  );
});

test("native cutover engine injects only policy-eligible active private V2 memory", async () => {
  let boundary;
  const engine = createClawLoreNativeContextEngineV1({
    version: "1.2.3",
    tenantId: "local",
    agentId: "main",
    workspaceId: "workspace-1",
    tokenBudget: 256,
    maxQueryChars: 4000,
    retrieveCandidates: async (request) => {
      boundary = request.boundary;
      const address = {
        schemaVersion: 2,
        ...request.boundary,
        retention: "durable",
      };
      return [
        {
          id: "active-1",
          section: "profile",
          text: "Use Simplified Chinese by default",
          targetAddress: address,
          lifecycle: "active",
          verification: "user_confirmed",
          freshness: "current",
          score: 1,
          confidence: 1,
        },
        {
          id: "candidate-1",
          section: "profile",
          text: "candidate must not inject",
          targetAddress: address,
          lifecycle: "candidate",
          verification: "user_confirmed",
          score: 1,
          confidence: 1,
        },
      ];
    },
  });
  assert.equal(engine.info.id, "clawlore");

  const result = await engine.assemble({
    sessionId: "session-1",
    sessionKey: "agent:main:telegram:default:direct:8176453077",
    messages: [{ role: "user", content: "hello" }],
    prompt: "language preference",
    tokenBudget: 128,
  });
  assert.equal(boundary.principalId, "telegram:default:8176453077");
  assert.match(result.systemPromptAddition, /Use Simplified Chinese/);
  assert.doesNotMatch(result.systemPromptAddition, /candidate must not inject/);
  assert.deepEqual(result.messages, [{ role: "user", content: "hello" }]);
  assert.equal(result.promptAuthority, "preassembly_may_overflow");
  assert.deepEqual(await engine.ingest({
    sessionId: "session-1",
    message: { role: "user", content: "do not persist transcript implicitly" },
  }), { ingested: false });
  assert.deepEqual(await engine.compact(), {
    ok: true,
    compacted: false,
    reason: "host_owned_compaction",
  });
});

test("native cutover engine fails closed for group and unresolved sessions", async () => {
  let calls = 0;
  const engine = createClawLoreNativeContextEngineV1({
    version: "1.2.3",
    tenantId: "local",
    agentId: "main",
    tokenBudget: 128,
    maxQueryChars: 4000,
    retrieveCandidates: async () => {
      calls += 1;
      return [];
    },
  });
  for (const sessionKey of [
    "agent:main:telegram:default:group:-100123",
    "agent:main:unknown",
  ]) {
    const result = await engine.assemble({
      sessionId: "session-group",
      sessionKey,
      messages: [],
      prompt: "query",
    });
    assert.equal(result.systemPromptAddition, undefined);
  }
  assert.equal(calls, 0);
});

test("shadow request registers nothing without matching readiness", () => {
  const config = normalizeClawLoreRuntimeConfigV1({ mode: "shadow" });

  const missing = new FixtureHost();
  const missingReceipt = composeClawLoreRuntimeV1({ config, host: missing, dependencies: dependencies() });
  assert.equal(missingReceipt.status, "blocked");
  assert.deepEqual(missingReceipt.blockingReasons, ["release_readiness_missing"]);
  assert.equal(missing.hooks.length, 0);
});

test("ready fixture shadow registers one observer and never mutates prompt or writes", async () => {
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
  });

  assert.equal(receipt.status, "registered");
  assert.deepEqual(receipt.registeredHooks, ["message_received"]);
  assert.equal(receipt.contextEngine.selected, "compatibility");
  assert.equal(receipt.contextEngineRegistered, false);
  assert.equal(receipt.toolRegistrations, 0);
  assert.equal(receipt.writeEnabled, false);
  assert.equal(receipt.promptMutationEnabled, false);
  assert.equal(host.hooks.length, 1);
  assert.equal(host.hooks[0].options.priority, -100);

  const hookResults = await host.emitMessageReceived(
    {
      runId: "private-run-id",
      messageId: "raw-message-id",
      content: "private prompt must not enter the trace",
      senderId: "joy-secret-id",
    },
    {
      channelId: "telegram",
      accountId: "default",
      conversationId: "joy-secret-id",
      sessionKey: "agent:main:telegram:default:direct:joy-secret-id",
      sessionId: "private-session-id",
      tokenBudget: 128,
    },
  );
  assert.deepEqual(hookResults, [undefined]);
  assert.equal(retrievalCalls, 1);
  assert.equal(sink.receipts.length, 1);
  assert.equal(sink.receipts[0].status, "completed");
  assert.equal(sink.receipts[0].selectedCount, 1);
  assert.equal(sink.receipts[0].retrievalInvoked, true);
  assert.equal(sink.receipts[0].ingressKind, "direct");
  assert.equal(sink.receipts[0].visibility, "private");
  assert.match(sink.receipts[0].traceId, /^clawlore-shadow-[a-f0-9]{20}$/);
  const serialized = JSON.stringify(sink.receipts);
  assert.doesNotMatch(serialized, /joy-secret-id|private-session-id|private prompt|Simplified Chinese/);
});

test("trusted message_received preserves group sender and conversation boundaries", async () => {
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
  });

  const results = await host.emitMessageReceived({
    runId: "group-run",
    messageId: "group-message",
    content: "group query",
    senderId: "group-sender",
    threadId: "topic-7",
  }, {
    channelId: "telegram",
    accountId: "default",
    conversationId: "group-conversation",
    sessionKey: "agent:main:telegram:group:group-conversation",
  });

  assert.deepEqual(results, [undefined]);
  assert.equal(boundary.principalId, "telegram:default:group-sender");
  assert.equal(boundary.visibility, "conversation");
  assert.equal(boundary.conversationId, "group-conversation");
  assert.equal(boundary.threadId, "topic-7");
  assert.equal(sink.receipts[0].retrievalInvoked, true);
  assert.equal(sink.receipts[0].ingressKind, "group");
  assert.equal(sink.receipts[0].visibility, "conversation");
});

test("unknown message_received chat type fails toward conversation scope", async () => {
  const host = new FixtureHost();
  let boundary;
  composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow" }),
    host,
    dependencies: dependencies({
      retrieveCandidates: async (request) => {
        boundary = request.boundary;
        return [];
      },
    }),
    readiness: readiness(),
  });

  await host.emitMessageReceived(
    { content: "unknown surface query", senderId: "user-unknown" },
    { channelId: "custom", accountId: "default", conversationId: "room-1" },
  );

  assert.equal(boundary.visibility, "conversation");
  assert.equal(boundary.conversationId, "room-1");
});

test("native ContextEngine request remains blocked even when fixture host is capable", () => {
  const host = new FixtureHost();
  const receipt = composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow", contextEngine: "native-opt-in" }),
    host,
    dependencies: dependencies(),
    readiness: readiness(),
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
      retrieveCandidates: async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      }),
      onObserverError: (code) => errors.push(code),
    }),
    readiness: readiness(),
  });
  const startedAt = Date.now();
  const timeoutResults = await timeoutHost.emitMessageReceived(
    {
      messageId: "timeout-message",
      content: "timeout retrieval query",
      senderId: "user-1",
    },
    {
      channelId: "telegram",
      accountId: "default",
      conversationId: "user-1",
      sessionKey: "agent:main:telegram:default:direct:user-1",
    },
  );
  assert.deepEqual(timeoutResults, [undefined]);
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
  });
  const sinkResults = await sinkHost.emitMessageReceived(
    {
      messageId: "sink-message",
      content: "sink failure query",
      senderId: "user-1",
    },
    {
      channelId: "telegram",
      accountId: "default",
      conversationId: "user-1",
      sessionKey: "agent:main:telegram:default:direct:user-1",
    },
  );
  assert.deepEqual(sinkResults, [undefined]);
  assert.deepEqual(errors, ["shadow_observer_timeout", "shadow_observer_failed"]);
});

test("shadow comparison emits only redacted lane metrics", async () => {
  const host = new FixtureHost();
  const sink = new InMemoryRuntimeShadowSinkV1();
  const targetAddress = {
    schemaVersion: 2, tenantId: "local", principalId: "telegram:default:user-1",
    agentId: "main", workspaceId: "workspace-1", platform: "telegram", accountId: "default",
    visibility: "private", retention: "durable",
  };
  composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow" }),
    host,
    dependencies: dependencies({
      traceSink: sink,
      retrieveCandidates: async () => [{ id: "legacy:raw-secret-id", section: "projectFacts",
        text: "primary secret content", targetAddress, lifecycle: "active", verification: "user_confirmed" }],
      retrieveComparisonCandidates: async () => [{ id: "raw-secret-id", section: "projectFacts",
        text: "comparison secret content", targetAddress, lifecycle: "active", verification: "user_confirmed" }],
    }),
    readiness: readiness(),
  });
  await host.emitMessageReceived({ content: "secret query", senderId: "user-1" }, {
    channelId: "telegram", accountId: "default", conversationId: "user-1",
    sessionKey: "agent:main:telegram:default:direct:user-1",
  });
  assert.equal(sink.receipts[0].comparison.status, "completed");
  assert.equal(sink.receipts[0].comparison.overlapRatio, 1);
  assert.equal(sink.receipts[0].comparison.rankAgreement, 1);
  assert.match(sink.receipts[0].comparison.primaryIdsDigest, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(sink.receipts[0]);
  assert.doesNotMatch(serialized, /raw-secret-id|secret content|secret query/);
});

test("shadow observers deduplicate sessions and enforce a hard concurrency bound", async () => {
  const host = new FixtureHost();
  const errors = [];
  const releases = [];
  let active = 0;
  let maximumActive = 0;
  composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow", maxLatencyMs: 25, maxConcurrent: 2 }),
    host,
    dependencies: dependencies({
      retrieveCandidates: async () => new Promise((resolve) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        releases.push(() => { active -= 1; resolve([]); });
      }),
      onObserverError: (code) => errors.push(code),
    }),
    readiness: readiness(),
  });
  const emit = (index, session = `session-${index}`) => host.emitMessageReceived(
    { content: "bounded query", senderId: `user-${index}` },
    { channelId: "telegram", accountId: "default", conversationId: `room-${index}`, sessionKey: session },
  );
  const first = emit(0, "same-session");
  const duplicate = emit(0, "same-session");
  const rest = Array.from({ length: 19 }, (_, index) => emit(index + 1));
  await Promise.all([first, duplicate, ...rest]);
  assert.equal(maximumActive, 2);
  assert.equal(releases.length, 2);
  assert.equal(errors.filter((code) => code === "shadow_observer_deduplicated").length, 1);
  assert.equal(errors.filter((code) => code === "shadow_observer_saturated").length, 18);
  assert.equal(errors.filter((code) => code === "shadow_observer_timeout").length, 2);
  for (const release of releases) release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 0);
});

test("a timed-out non-cooperative provider releases its concurrency slot and is tracked as late", async () => {
  const host = new FixtureHost();
  const errors = [];
  const metrics = [];
  let calls = 0;
  composeClawLoreRuntimeV1({
    config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow", maxLatencyMs: 25, maxConcurrent: 1 }),
    host,
    dependencies: dependencies({
      retrieveCandidates: async () => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return [];
      },
      onObserverError: (code) => errors.push(code),
      onObserverMetrics: (value) => metrics.push({ ...value }),
    }),
    readiness: readiness(),
  });
  await host.emitMessageReceived(
    { content: "first request", senderId: "user-1" },
    { channelId: "telegram", sessionKey: "agent:main:telegram:default:direct:user-1" },
  );
  await host.emitMessageReceived(
    { content: "second request", senderId: "user-2" },
    { channelId: "telegram", sessionKey: "agent:main:telegram:default:direct:user-2" },
  );
  assert.equal(calls, 2);
  assert.equal(errors.filter((code) => code === "shadow_observer_timeout").length, 1);
  assert.equal(errors.filter((code) => code === "shadow_observer_saturated").length, 0);
  assert.ok(metrics.some((value) => value.active === 0 && value.late === 1 && value.timeouts === 1));
});
