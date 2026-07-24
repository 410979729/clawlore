import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { runtimeTransitionPolicyBlocksV1 } = jiti("../src/application/runtime-transition-policy.ts");

const safe = {
  agentToolProfile: "v2-write",
  autoCapture: false,
  smartExtraction: false,
  sessionStrategy: "none",
};

test("V2-write and cutover admit only the store-only parity-preserving configuration", () => {
  assert.deepEqual(runtimeTransitionPolicyBlocksV1({
    ...safe,
    mode: "v2-write",
    contextEngine: "compatibility",
  }), []);
  assert.deepEqual(runtimeTransitionPolicyBlocksV1({
    ...safe,
    mode: "cutover",
    contextEngine: "native-opt-in",
  }), []);
});

test("transition policy blocks lifecycle and automatic legacy writers", () => {
  assert.deepEqual(runtimeTransitionPolicyBlocksV1({
    mode: "cutover",
    contextEngine: "compatibility",
    agentToolProfile: "memory-write",
    autoCapture: true,
    smartExtraction: true,
    sessionStrategy: "memoryReflection",
  }), [
    "cutover_requires_native_context_engine",
    "cutover_requires_store_only_tool_profile",
    "cutover_requires_legacy_automatic_writers_disabled",
  ]);
});
