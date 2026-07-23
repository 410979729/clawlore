import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { diagnoseLlmFailure } = jiti("../src/llm-failure-diagnostic.ts");

test("LLM failure diagnostics expose only stable transport categories", () => {
  assert.deepEqual(
    diagnoseLlmFailure({ status: 401, code: "invalid_api_key", message: "must not be returned" }),
    { category: "authentication", status: 401, code: "invalid_api_key" },
  );
  assert.deepEqual(
    diagnoseLlmFailure({ statusCode: 429, type: "rate_limit_error", headers: { authorization: "secret" } }),
    { category: "rate_limit", status: 429, code: "rate_limit_error" },
  );
  assert.deepEqual(
    diagnoseLlmFailure(Object.assign(new Error("request timed out at a private URL"), { name: "AbortError" })),
    { category: "timeout" },
  );
  assert.deepEqual(
    diagnoseLlmFailure({ code: "ENOTFOUND", hostname: "private.internal" }),
    { category: "network_failure", code: "ENOTFOUND" },
  );
  const result = diagnoseLlmFailure({ status: 403, code: "forbidden", body: "private response body" });
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(result, { category: "authorization", status: 403, code: "forbidden" });
});

test("LLM failure diagnostics omit unknown codes even when they look syntactically safe", () => {
  const secretShaped = [
    "sk-synthetic-secret-value-1234567890",
    "Bearer.synthetic-token-material",
    "eyJhbGciOiJIUzI1NiJ9.synthetic.signature",
    "https-private.internal-token-value",
    "x".repeat(200),
  ];
  for (const code of secretShaped) {
    assert.deepEqual(
      diagnoseLlmFailure({ status: 401, code }),
      { category: "authentication", status: 401 },
    );
    assert.deepEqual(
      diagnoseLlmFailure({ status: 429, type: code }),
      { category: "rate_limit", status: 429 },
    );
  }

  assert.deepEqual(
    diagnoseLlmFailure({ code: "ECONNSECRET_SYNTHETIC_VALUE" }),
    { category: "unknown" },
  );
});
