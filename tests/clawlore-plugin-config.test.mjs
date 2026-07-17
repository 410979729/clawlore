import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { parsePluginConfig } = jiti("../src/plugin-config.ts");

test("plugin config preserves privacy-first defaults and local embedding defaults", () => {
  const parsed = parsePluginConfig({ embedding: {} });

  assert.deepEqual(parsed.embedding, {
    provider: "local-hash",
    apiKey: undefined,
    model: "hash-v1",
    baseURL: undefined,
    dimensions: undefined,
    omitDimensions: undefined,
    taskQuery: undefined,
    taskPassage: undefined,
    normalized: undefined,
    chunking: undefined,
    groupId: undefined,
  });
  assert.equal(parsed.vectorBackend, "lancedb");
  assert.equal(parsed.autoCapture, false);
  assert.equal(parsed.autoBackup, false);
  assert.equal(parsed.autoRecall, false);
  assert.equal(parsed.recallMode, "full");
  assert.deepEqual(parsed.principalIsolation, {
    enabled: true,
    groupMemory: "deny",
    legacyAgentScopePrincipals: [],
    allowGlobalRead: false,
  });
  assert.equal(parsed.sessionStrategy, "none");
  assert.deepEqual(parsed.memoryReflection, {
    enabled: false,
    storeToLanceDB: false,
    writeLegacyCombined: true,
    injectMode: "inheritance+derived",
    agentId: undefined,
    messageCount: 120,
    maxInputChars: 24_000,
    timeoutMs: 20_000,
    thinkLevel: "medium",
    errorReminderMaxEntries: 3,
    dedupeErrorSignals: true,
  });
});

test("plugin config preserves numeric normalization and legacy session compatibility", () => {
  const parsed = parsePluginConfig({
    embedding: { provider: "local-debug", dimensions: "1536" },
    autoRecallQueryMaxChars: 20_000,
    autoRecallMaxItems: "7.9",
    sessionMemory: { enabled: true, messageCount: 42 },
    memoryReflection: { messageCount: "64", thinkLevel: "low" },
    principalIsolation: {
      enabled: false,
      groupMemory: "conversation",
      legacyAgentScopePrincipals: [" main ", "", 7],
      allowGlobalRead: true,
    },
  });

  assert.equal(parsed.embedding.provider, "local-debug");
  assert.equal(parsed.embedding.model, "debug-hash-v1");
  assert.equal(parsed.embedding.dimensions, 1536);
  assert.equal(parsed.autoRecallQueryMaxChars, 12_000);
  assert.equal(parsed.autoRecallMaxItems, 7);
  assert.equal(parsed.sessionStrategy, "systemSessionMemory");
  assert.deepEqual(parsed.sessionMemory, { enabled: true, messageCount: 42 });
  assert.equal(parsed.memoryReflection.messageCount, 64);
  assert.equal(parsed.memoryReflection.thinkLevel, "low");
  assert.deepEqual(parsed.principalIsolation, {
    enabled: false,
    groupMemory: "conversation",
    legacyAgentScopePrincipals: ["main"],
    allowGlobalRead: true,
  });
});

test("plugin config fails closed for missing or malformed hosted credentials", () => {
  assert.throws(() => parsePluginConfig(undefined), /clawlore config required/);
  assert.throws(() => parsePluginConfig({}), /embedding config is required/);
  assert.throws(
    () => parsePluginConfig({ embedding: { provider: "openai-compatible" } }),
    /embedding.apiKey is required for hosted embedding providers/,
  );
  assert.throws(
    () => parsePluginConfig({ embedding: { apiKey: ["first", " "] } }),
    /embedding.apiKey\[1\] is invalid/,
  );
  assert.throws(
    () => parsePluginConfig({ embedding: { apiKey: { secret: "ref" } } }),
    /embedding.apiKey must be a string or non-empty array of strings/,
  );
});

test("plugin config resolves canonical runtime input and rejects conflicting compatibility input", () => {
  const runtime = { mode: "shadow", maxConcurrent: 4 };
  const canonical = parsePluginConfig({ embedding: {}, runtime });
  const compatible = parsePluginConfig({ embedding: {}, clawloreV2: runtime });
  assert.deepEqual(canonical.runtime, compatible.runtime);

  assert.throws(
    () => parsePluginConfig({
      embedding: {},
      runtime,
      clawloreV2: { ...runtime, maxConcurrent: 3 },
    }),
    /Conflicting ClawLore runtime and deprecated clawloreV2 configuration/,
  );
});
