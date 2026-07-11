import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);
const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

const publicExperienceTools = Object.entries(manifest.toolMetadata)
  .filter(([name, metadata]) => name.startsWith("scope_recall_") && metadata.discoverable === true)
  .map(([name]) => name)
  .sort();

assert.deepEqual(publicExperienceTools, [
  "scope_recall_experience_preflight",
  "scope_recall_playbook_inspect",
  "scope_recall_playbook_search",
]);
assert.deepEqual(
  manifest.configContracts.secretInputs.paths.map((item) => item.path),
  ["embedding.apiKey", "embedding.apiKey.*", "retrieval.rerankApiKey", "llm.apiKey"],
);
assert.equal(manifest.configSchema.properties.allowAgentOperatorTools.default, false);
assert.equal(
  manifest.configSchema.properties.memoryCompaction.properties.startupMode.default,
  "off",
);
assert.match(entry, /legacy plaintext autoBackup is disabled/);
assert.match(entry, /dryRun: true/);
assert.doesNotMatch(entry, /backup timers armed/);
assert.doesNotMatch(entry, /recordCompactionRun\(compactionStateFile\)/);

console.log(JSON.stringify({
  ok: true,
  secretInputPaths: manifest.configContracts.secretInputs.paths.length,
  publicExperienceTools,
  agentOperatorToolsDefault: false,
  startupCompaction: "off-or-dry-run-only",
  plaintextAutoBackup: "disabled",
}, null, 2));
