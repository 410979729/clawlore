import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  AGENT_TOOL_PROFILES,
  agentToolCapabilities,
  effectiveAgentToolCapabilities,
} = jiti("../src/agent-tool-profile.ts");

test("V2 authority narrows legacy mutation capabilities without removing store", () => {
  assert.deepEqual(effectiveAgentToolCapabilities("operator", true), {
    memoryWrites: true,
    memoryLifecycleWrites: false,
    operator: true,
    selfImprovement: false,
    secretIndex: false,
  });
  assert.deepEqual(
    effectiveAgentToolCapabilities("memory-write", false),
    agentToolCapabilities("memory-write"),
  );
});
const { registerAllMemoryTools } = jiti("../src/tools.ts");
const { registerExperienceTools } = jiti("../src/experience-tools.ts");

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);

function manifestToolNames(profile) {
  return manifest.contracts.tools.filter((toolName) => {
    const signals = manifest.toolMetadata?.[toolName]?.configSignals;
    if (!Array.isArray(signals) || signals.length === 0) return true;
    return signals.some((signal) => {
      const mode = signal.mode;
      if (!mode || mode.path !== "agentToolProfile") return false;
      return mode.allowed.includes(profile);
    });
  }).sort();
}

function runtimeToolNames(profile) {
  const names = new Set();
  const api = {
    registerTool(_factory, metadata) {
      assert.equal(typeof metadata?.name, "string");
      names.add(metadata.name);
    },
  };
  const capabilities = agentToolCapabilities(profile);
  const context = {
    retriever: {},
    store: {},
    scopeManager: {},
    embedder: {},
    db: async () => null,
  };
  registerAllMemoryTools(api, context, {
    allowAgentMemoryWriteTools: capabilities.memoryWrites,
    allowAgentMemoryLifecycleTools: capabilities.memoryLifecycleWrites,
    enableManagementTools: capabilities.operator,
    enableSelfImprovementTools: capabilities.selfImprovement,
    secretIndexToolsEnabled: capabilities.secretIndex,
  });
  registerExperienceTools(api, context, {
    enableManagementTools: capabilities.operator,
  });
  return [...names].sort();
}

test("manifest availability equals runtime registration for every Agent tool profile", () => {
  for (const profile of AGENT_TOOL_PROFILES) {
    assert.deepEqual(runtimeToolNames(profile), manifestToolNames(profile), profile);
  }
});
