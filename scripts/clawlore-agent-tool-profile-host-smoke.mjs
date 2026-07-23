#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AGENT_TOOL_PROFILES,
  DEFAULT_AGENT_TOOL_PROFILE,
  agentToolCapabilities,
} from "../dist/src/agent-tool-profile.js";
import { registerExperienceTools } from "../dist/src/experience-tools.js";
import { registerAllMemoryTools } from "../dist/src/tools.js";

const openClawPackage = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: clawlore-agent-tool-profile-host-smoke.mjs <openclaw-package-root>");
}
const distDir = resolve(openClawPackage, "dist");
const evaluatorFiles = (await readdir(distDir))
  .filter((name) => /^manifest-tool-availability-.*\.js$/u.test(name))
  .sort();
assert.equal(
  evaluatorFiles.length,
  1,
  "exactly one OpenClaw manifest-tool availability evaluator is required",
);
const hostModule = await import(pathToFileURL(resolve(distDir, evaluatorFiles[0])).href);
const manifestConfigSignalPasses =
  hostModule.manifestConfigSignalPasses ?? hostModule.r;
assert.equal(
  typeof manifestConfigSignalPasses,
  "function",
  "OpenClaw manifest config-signal evaluator export is unavailable",
);

const manifest = JSON.parse(
  await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);

function manifestToolNames(profile) {
  const config = {
    plugins: {
      entries: {
        clawlore: {
          config: {
            embedding: { provider: "local-hash" },
            ...(profile ? { agentToolProfile: profile } : {}),
          },
        },
      },
    },
  };
  return manifest.contracts.tools.filter((toolName) => {
    const signals = manifest.toolMetadata?.[toolName]?.configSignals;
    if (!Array.isArray(signals) || signals.length === 0) return true;
    return signals.some((signal) =>
      manifestConfigSignalPasses({ config, env: {}, signal }));
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
    enableManagementTools: capabilities.operator,
    enableSelfImprovementTools: capabilities.selfImprovement,
    secretIndexToolsEnabled: capabilities.secretIndex,
  });
  registerExperienceTools(api, context, {
    enableManagementTools: capabilities.operator,
  });
  return [...names].sort();
}

for (const profile of AGENT_TOOL_PROFILES) {
  assert.deepEqual(
    manifestToolNames(profile),
    runtimeToolNames(profile),
    `OpenClaw host availability differs from runtime registration for ${profile}`,
  );
}
assert.deepEqual(
  manifestToolNames(undefined),
  runtimeToolNames(DEFAULT_AGENT_TOOL_PROFILE),
  "OpenClaw host default availability differs from runtime default registration",
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  openClawEvaluator: evaluatorFiles[0],
  profiles: AGENT_TOOL_PROFILES.length,
  defaultProfile: DEFAULT_AGENT_TOOL_PROFILE,
})}\n`);
