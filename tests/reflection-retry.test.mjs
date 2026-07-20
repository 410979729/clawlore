import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const {
  classifyReflectionRetry,
  runWithReflectionTransientRetryOnce,
} = jiti("../src/reflection-retry.ts");

test("reflection retry classifies transient upstream failures but not auth failures", () => {
  const transient = classifyReflectionRetry({
    inReflectionScope: true,
    retryCount: 0,
    usefulOutputChars: 0,
    error: new Error("Gateway timeout 504"),
  });
  assert.equal(transient.retryable, true);
  assert.equal(transient.reason, "transient_upstream_failure");

  const auth = classifyReflectionRetry({
    inReflectionScope: true,
    retryCount: 0,
    usefulOutputChars: 0,
    error: new Error("401 unauthorized invalid api key"),
  });
  assert.equal(auth.retryable, false);
  assert.equal(auth.reason, "non_retry_error");
});

test("reflection retry diagnostics never expose the classified provider message", async () => {
  const secret = `npm_${"A".repeat(36)}`;
  const decision = classifyReflectionRetry({
    inReflectionScope: true,
    retryCount: 0,
    usefulOutputChars: 0,
    error: new Error(`socket hang up token=${secret}`),
  });
  assert.equal(decision.retryable, true);
  assert.equal(decision.normalizedError.includes(secret), false);

  const logs = [];
  await assert.rejects(runWithReflectionTransientRetryOnce({
    scope: "reflection",
    runner: "embedded",
    retryState: { count: 0 },
    random: () => 0,
    sleep: async () => {},
    onLog: (_level, message) => logs.push(message),
    async execute() {
      throw new Error(`socket hang up token=${secret}`);
    },
  }));
  assert.equal(logs.join("\n").includes(secret), false);
});

test("reflection retry retries transient failure once before returning recovered output", async () => {
  let attempts = 0;
  const result = await runWithReflectionTransientRetryOnce({
    scope: "reflection",
    runner: "embedded",
    retryState: { count: 0 },
    random: () => 0,
    sleep: async () => {},
    async execute() {
      attempts += 1;
      if (attempts === 1) throw new Error("socket hang up");
      return "recovered";
    },
  });

  assert.equal(result, "recovered");
  assert.equal(attempts, 2);
});
