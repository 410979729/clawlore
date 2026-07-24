import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("ClawLore is the canonical package, manifest, config, and command identity", () => {
  const packageJson = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("openclaw.plugin.json"));
  const commands = manifest.commandAliases.map((entry) => entry.name);

  assert.equal(packageJson.name, "clawlore");
  assert.equal(packageJson.version, "1.2.3");
  assert.equal(packageJson.repository.url, "git+https://github.com/410979729/clawlore.git");
  assert.equal(manifest.id, "clawlore");
  assert.equal(manifest.name, "ClawLore");
  assert.deepEqual(manifest.legacyPluginIds, ["scope-recall-openclaw"]);
  assert.deepEqual(commands, ["clawlore", "scope-recall", "memory-pro"]);
  assert.ok(manifest.configSchema.properties.runtime);
  assert.match(
    manifest.configSchema.properties.clawloreV2.description,
    /Deprecated compatibility alias for runtime/,
  );

  for (const metadata of Object.values(manifest.toolMetadata || {})) {
    for (const signal of metadata.configSignals || []) {
      assert.equal(signal.rootPath, "plugins.entries.clawlore.config");
    }
  }
});

test("identity compatibility is explicit and live release checks stay canonical", () => {
  const identity = read("src/product-identity.ts");
  const indexSource = read("index.ts");
  const authConfigSource = read("src/cli/auth-config-transaction.ts");
  const coreRuntimeSource = read("src/core-memory-runtime.ts");
  const releaseGate = read("scripts/release-gate.mjs");
  const vectorRepairSmoke = read("scripts/smoke-vector-repair.mjs");
  const transition = read("docs/clawlore/identity-transition-v1.md");

  assert.match(identity, /CLAWLORE_PLUGIN_ID = "clawlore"/);
  assert.match(identity, /CLAWLORE_LEGACY_PLUGIN_IDS = \["scope-recall-openclaw"\]/);
  assert.match(identity, /CLAWLORE_RUNTIME_CONFIG_KEY = "runtime"/);
  assert.match(identity, /CLAWLORE_LEGACY_RUNTIME_CONFIG_KEYS = \["clawloreV2"\]/);
  assert.match(coreRuntimeSource, /CLAWLORE_LEGACY_DEFAULTS\.dataDirectoryName/);
  assert.match(coreRuntimeSource, /resolveDefaultOauthPathWithCompatibility/);
  assert.match(authConfigSource, /CLAWLORE_LEGACY_DEFAULTS\.oauthDirectoryName/);
  assert.match(releaseGate, /extensions\/clawlore/);
  assert.match(releaseGate, /assertRepositoryIdentity/);
  assert.match(releaseGate, /ls-remote/);
  assert.match(releaseGate, /\["plugins", "inspect", "clawlore", "--json"\]/);
  assert.match(releaseGate, /\["clawlore", "doctor", "--json", "--quiet"\]/);
  assert.match(transition, /Never load legacy and canonical plugin copies simultaneously/);
  assert.match(transition, /scope_recall_\*/);
  assert.doesNotMatch(indexSource, /clawlore-v2:/);
  assert.doesNotMatch(vectorRepairSmoke, /scope-recall-vector-repair-/);
});

test("current operator documentation leads with ClawLore while documenting aliases", () => {
  const readme = read("README.md");
  const configuration = read("docs/configuration.md");
  const runbook = read("docs/operator-runbook.md");

  assert.match(readme, /^# ClawLore$/m);
  assert.match(readme, /openclaw clawlore doctor/);
  assert.match(readme, /openclaw scope-recall.*compatibility/s);
  assert.match(configuration, /plugins\.entries\.clawlore\.config/);
  assert.match(runbook, /plugins inspect clawlore --json/);
  assert.match(runbook, /clawlore doctor --json --quiet/);
  assert.doesNotMatch(runbook, /plugins inspect scope-recall-openclaw/);
});
