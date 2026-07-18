import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { ensurePluginConfigRoot } from "../dist/src/cli/auth-config-transaction.js";

const [configPath, dbPath] = process.argv.slice(2);
if (!configPath || !dbPath) {
  throw new Error("usage: packed-legacy-identity-smoke.mjs <openclaw-config> <db-path>");
}

const secretRef = Object.freeze({
  source: "env",
  provider: "default",
  id: "CLAWLORE_RELEASE_FIXTURE_CREDENTIAL",
});
const pluginConfig = {
  admissionControl: { enabled: true },
  autoBackup: false,
  autoCapture: true,
  autoRecall: true,
  autoRecallMaxChars: 4000,
  autoRecallMaxItems: 6,
  autoRecallMinLength: 6,
  autoRecallMinRepeated: 2,
  autoRecallPerItemMaxChars: 800,
  autoRecallTimeoutMs: 5000,
  dbPath,
  embedding: { provider: "local-hash", dimensions: 64 },
  enableManagementTools: true,
  extractMaxChars: 12000,
  extractMinMessages: 4,
  extractionThrottle: { skipLowValue: true },
  llm: { auth: "api-key", apiKey: secretRef, model: "fixture-model" },
  maxRecallPerTurn: 10,
  mdMirror: { enabled: false },
  memoryCompaction: { enabled: false },
  recallMode: "summary",
  retrieval: { mode: "hybrid", rerank: "none" },
  runtime: { mode: "disabled", contextEngine: "compatibility" },
  sessionCompression: { enabled: false },
  sessionMemory: { enabled: true },
  sessionStrategy: "memoryReflection",
  smartExtraction: true,
  taskExperienceCapture: { enabled: true },
  vectorBackend: "sqlite-bruteforce",
  workspaceBoundary: { userMdExclusive: { enabled: true } },
};
assert.equal(Object.keys(pluginConfig).length, 30);

const config = JSON.parse(await readFile(configPath, "utf8"));
config.plugins ??= {};
config.plugins.allow = ["telegram", "scope-recall-openclaw", "openai"];
config.plugins.entries = {
  "scope-recall-openclaw": { enabled: true, config: pluginConfig },
};
config.plugins.slots = { ...(config.plugins.slots ?? {}), memory: "scope-recall-openclaw" };

const expectedEntry = structuredClone(config.plugins.entries["scope-recall-openclaw"]);
const migratedConfig = ensurePluginConfigRoot(config, "clawlore");
assert.deepEqual(Object.keys(config.plugins.entries), ["clawlore"]);
assert.deepEqual(config.plugins.entries.clawlore, expectedEntry);
assert.strictEqual(migratedConfig, config.plugins.entries.clawlore.config);
assert.equal(Object.keys(migratedConfig).length, 30);
assert.deepEqual(migratedConfig.llm.apiKey, secretRef);
assert.deepEqual(config.plugins.allow, ["telegram", "clawlore", "openai"]);
assert.equal(config.plugins.slots.memory, "clawlore");

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write("packed legacy identity migration smoke ok\n");
