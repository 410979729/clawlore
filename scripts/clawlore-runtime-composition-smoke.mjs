import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { buildReleaseReadinessReceipt } = jiti("../src/v2/application/release-readiness.ts");
const {
  InMemoryRuntimeShadowSinkV1,
  composeClawLoreRuntimeV1,
  normalizeClawLoreRuntimeConfigV1,
} = jiti("../src/v2/adapters/openclaw/runtime-composition-root.ts");

class FixtureHost {
  constructor() {
    this.capabilities = {
      ingest: true, assemble: true, afterTurn: true, maintain: true,
      compact: true, subagentLifecycle: true, tokenBudget: true, abortSignal: true,
    };
    this.hooks = [];
  }

  on(event, handler, options) {
    this.hooks.push({ event, handler, options });
  }
}

const commonDependencies = {
  tenantId: "local",
  agentId: "main",
  workspaceId: "fixture-workspace",
  retrieveCandidates: async ({ boundary }) => [{
    id: "fixture-memory",
    section: "profile",
    text: "fixture-only memory",
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
      retention: "working",
    },
    lifecycle: "active",
    verification: "user_confirmed",
    freshness: "current",
    score: 1,
    confidence: 1,
  }],
};

const disabledHost = new FixtureHost();
const disabled = composeClawLoreRuntimeV1({
  config: normalizeClawLoreRuntimeConfigV1(undefined),
  host: disabledHost,
  dependencies: commonDependencies,
});
assert.equal(disabled.status, "disabled");
assert.equal(disabledHost.hooks.length, 0);

const readiness = buildReleaseReadinessReceipt({
  rolloutId: "fixture-host-smoke",
  requestedMode: "shadow",
  currentMode: "disabled",
  evidence: {
    focusedTests: true, fullTests: true, typecheck: true, build: true,
    moduleBoundaries: true, releaseGate: true, snapshotVerified: false,
    migrationDrill: false, rollbackDrill: false, legacyHashUnchanged: false,
    forbiddenScopeViolations: 0,
  },
  provenance: {
    sourceCommit: "a".repeat(40),
    runtimeDigest: "1".repeat(64),
    packageDigest: "2".repeat(64),
    lockDigest: "3".repeat(64),
    configDigest: "4".repeat(64),
    truthSnapshotDigest: "5".repeat(64),
    testLogDigest: "6".repeat(64),
    generatedBy: "runtime-composition-smoke",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    lifecycle: { active: 1, candidate: 0, archived: 0, other: 0 },
    shadow: {
      sampleCount: 0, directSamples: 0, groupSamples: 0,
      positiveCandidateSamples: 0, overlapRatio: 0, rankAgreement: 0,
      p95LatencyMs: 0, forbiddenViolations: 0, promptBudgetViolations: 0,
    },
  },
});
const sink = new InMemoryRuntimeShadowSinkV1();
const shadowHost = new FixtureHost();
const shadow = composeClawLoreRuntimeV1({
  config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow", contextEngine: "compatibility" }),
  host: shadowHost,
  dependencies: { ...commonDependencies, traceSink: sink },
  readiness,
});
assert.equal(shadow.status, "registered");
assert.equal(shadowHost.hooks.length, 1);
const hookResult = await shadowHost.hooks[0].handler(
  {
    runId: "run-1",
    messageId: "message-1",
    content: "do not persist this prompt",
    senderId: "fixture-user",
  },
  {
    channelId: "telegram",
    accountId: "default",
    conversationId: "fixture-user",
    sessionKey: "agent:main:telegram:default:direct:fixture-user",
    sessionId: "fixture-session",
    tokenBudget: 128,
  },
);
assert.equal(hookResult, undefined);
assert.equal(sink.receipts.length, 1);
assert.equal(sink.receipts[0].status, "completed");
assert.equal(sink.receipts[0].selectedCount, 1);

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  status: "pass",
  defaultMode: disabled.requestedMode,
  disabledHookCount: disabledHost.hooks.length,
  shadowStatus: shadow.status,
  shadowHookCount: shadowHost.hooks.length,
  shadowReceiptStatus: sink.receipts[0].status,
  retrievalInvoked: sink.receipts[0].retrievalInvoked,
  selectedCount: sink.receipts[0].selectedCount,
  toolRegistrations: shadow.toolRegistrations,
  writeEnabled: shadow.writeEnabled,
  promptMutationEnabled: shadow.promptMutationEnabled,
  contextEngineRegistered: shadow.contextEngineRegistered,
})}\n`);
