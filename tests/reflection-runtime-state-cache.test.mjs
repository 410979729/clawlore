import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { ReflectionRuntimeState } = jiti("../src/reflection-runtime-state.ts");

test("reflection agent slice cache is LRU-bounded and TTL-pruned", async () => {
  let now = 1_000;
  let listCalls = 0;
  const state = new ReflectionRuntimeState({
    store: {
      async list() {
        listCalls += 1;
        return [];
      },
    },
    sessionTtlMs: 1_000,
    maxTrackedSessions: 3,
    agentSliceTtlMs: 10,
    now: () => now,
  });

  for (let index = 0; index < 10; index += 1) {
    await state.loadAgentSlices(`agent-${index}`, [`user:${index}`]);
  }
  assert.equal(listCalls, 20);
  await state.loadAgentSlices("agent-9", ["user:9"]);
  assert.equal(listCalls, 20);
  await state.loadAgentSlices("agent-0", ["user:0"]);
  assert.equal(listCalls, 22);

  now += 11;
  await state.loadAgentSlices("agent-9", ["user:9"]);
  assert.equal(listCalls, 24);
});
