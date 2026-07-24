import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

test("tool facades preserve the pre-split runtime export contract", () => {
  const tools = jiti("../src/tools.ts");
  assert.deepEqual(Object.keys(tools).sort(), [
    "MEMORY_CATEGORIES",
    "_resetWarnedMissingAgentIdState",
    "registerAllMemoryTools",
    "registerMemoryArchiveTool",
    "registerMemoryCompactTool",
    "registerMemoryContextTool",
    "registerMemoryDebugTool",
    "registerMemoryExplainRankTool",
    "registerMemoryForgetTool",
    "registerMemoryGovernTool",
    "registerMemoryInspectTool",
    "registerMemoryListTool",
    "registerMemoryPromoteTool",
    "registerMemoryRecallTool",
    "registerMemoryStatsTool",
    "registerMemoryStoreSecretIndexTool",
    "registerMemoryStoreTool",
    "registerMemoryUpdateTool",
    "registerSelfImprovementExtractSkillTool",
    "registerSelfImprovementLogTool",
    "registerSelfImprovementReviewTool",
    "safeToolFailure",
  ].sort());

  const experience = jiti("../src/experience-tools.ts");
  assert.deepEqual(Object.keys(experience).sort(), [
    "EXPERIENCE_TOOL_NAMES",
    "registerEpisodeCompleteTool",
    "registerEpisodeCreateTool",
    "registerExperiencePreflightTool",
    "registerExperienceStatsTool",
    "registerExperienceTools",
    "registerPlaybookCreateTool",
    "registerPlaybookFeedbackTool",
    "registerPlaybookInspectTool",
    "registerPlaybookSearchTool",
    "resolveExperienceRuntime",
    "safeExperienceToolFailure",
  ].sort());
});

test("split CLI policy resolves package identity from the source layout", () => {
  const policy = jiti("../src/cli/cli-runtime-policy.ts");
  assert.equal(policy.getPluginVersion(), "1.2.3");
});

test("current runtime code uses canonical modules and V2 paths only for versioned contracts", () => {
  const runtimeRegistration = readFileSync(
    new URL("../src/runtime-shadow-registration.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(runtimeRegistration, /\.\/v2\//);

  const canonicalFiles = [
    "../src/application/context-composer.ts",
    "../src/application/identity-resolver.ts",
    "../src/application/legacy-address-mapper.ts",
    "../src/application/policy-decision.ts",
    "../src/adapters/openclaw/compatibility-context-adapter.ts",
    "../src/adapters/openclaw/legacy-context-sources.ts",
    "../src/adapters/openclaw/legacy-shadow-retrieval.ts",
    "../src/adapters/openclaw/native-shadow-retrieval.ts",
    "../src/adapters/openclaw/runtime-composition-root.ts",
    "../src/adapters/openclaw/runtime-rollout-control.ts",
  ];
  for (const relative of canonicalFiles) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']*v2\/[^"']+)["']/g)) {
      assert.match(match[1], /v2\/domain\/(?:context-pack|memory-address|release)\.js$/);
    }
  }

  for (const relative of [
    "../src/v2/application/context-composer.ts",
    "../src/v2/application/identity-resolver.ts",
    "../src/v2/application/legacy-address-mapper.ts",
    "../src/v2/application/policy-decision.ts",
    "../src/v2/adapters/openclaw/compatibility-context-adapter.ts",
    "../src/v2/adapters/openclaw/context-engine-skeleton.ts",
    "../src/v2/adapters/openclaw/legacy-context-sources.ts",
    "../src/v2/adapters/openclaw/legacy-shadow-retrieval.ts",
    "../src/v2/adapters/openclaw/native-shadow-retrieval.ts",
    "../src/v2/adapters/openclaw/runtime-composition-root.ts",
    "../src/v2/adapters/openclaw/runtime-rollout-control.ts",
    "../src/v2/adapters/openclaw/runtime-shadow.ts",
    "../src/v2/operator/support-bundle.ts",
  ]) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /@deprecated/);
    assert.match(source, /^\/\*\*[\s\S]+export \* from /);
    assert.doesNotMatch(source, /\n(?:export )?(?:class|function|interface|type|const) /);
  }
});
