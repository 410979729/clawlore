import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { formatEmbeddingProviderError } = jiti("../src/embedder.ts");

test("embedding provider errors preserve classification without exposing raw provider material", () => {
  const secret = `npm_${"A".repeat(36)}`;
  const error = Object.assign(
    new Error(`401 unauthorized api key ${secret}`),
    { status: 401, code: "invalid_api_key" },
  );
  const formatted = formatEmbeddingProviderError(error, {
    baseURL: `not-a-url-${secret}`,
    model: secret,
  });

  assert.match(formatted, /Embedding provider authentication failed/u);
  assert.match(formatted, /status=401/u);
  assert.match(formatted, /code=invalid_api_key/u);
  assert.match(formatted, /Error\(len=\d+,hash=[a-f0-9]{12}\)/u);
  assert.equal(formatted.includes(secret), false);
  assert.equal(formatted.includes("not-a-url"), false);
});

test("embedding adapters never append raw HTTP response bodies or raw error causes", () => {
  const source = readFileSync(new URL("../src/embedder.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Ollama embedding failed:[^\n]*body/u);
  assert.doesNotMatch(source, /MiniMax embedding failed:[^\n]*text\.slice/u);
  assert.doesNotMatch(source, /cause:\s*(?:lastError|error)/u);
  assert.doesNotMatch(source, /console\.warn\([^\n]*,\s*chunkError\)/u);
});
