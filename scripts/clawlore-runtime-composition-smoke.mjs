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
      visibility: "private",
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
});
const sink = new InMemoryRuntimeShadowSinkV1();
const shadowHost = new FixtureHost();
const shadow = composeClawLoreRuntimeV1({
  config: normalizeClawLoreRuntimeConfigV1({ mode: "shadow", contextEngine: "compatibility" }),
  host: shadowHost,
  dependencies: { ...commonDependencies, traceSink: sink },
  readiness,
  approval: {
    schemaVersion: 1,
    rolloutId: "fixture-host-smoke",
    mode: "shadow",
    decision: "approved",
    actor: "operator:fixture-smoke",
    approvedAt: "2026-07-12T03:10:00.000Z",
  },
});
assert.equal(shadow.status, "registered");
assert.equal(shadowHost.hooks.length, 1);
const hookResult = await shadowHost.hooks[0].handler(
  { id: "message-1", prompt: "do not persist this prompt" },
  {
    agentId: "main", senderId: "fixture-user", platform: "telegram",
    accountId: "default", chatType: "direct", conversationId: "fixture-user",
    sessionId: "fixture-session", tokenBudget: 128,
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
