import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  buildReflectionPrompt,
  createReflectionTextGenerator,
} = jiti("../src/reflection-generation.ts");

const errorSignal = {
  at: 1,
  toolName: "shell",
  summary: "command failed",
  source: "tool_error",
  signature: "command failed",
  signatureHash: "1234567890abcdef",
};

test("reflection prompt preserves the schema, clipped input, and bounded error hints", () => {
  const prompt = buildReflectionPrompt("0123456789", 4, [errorSignal]);
  assert.match(prompt, /## Context \(session background\)/);
  assert.match(prompt, /## Derived/);
  assert.match(prompt, /1\. \[shell\] command failed \(sig:12345678\)/);
  assert.match(prompt, /INPUT:\n```\n6789\n```/);
  assert.equal(prompt.includes("012345"), false);
});

test("reflection generator maps the configured provider/model into the embedded run", async () => {
  let embeddedParams;
  const generate = createReflectionTextGenerator({
    diagnosticErrorSummary: (error) => String(error?.message ?? error),
    diagnosticIdentifier: String,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    loadEmbeddedRunner: async () => async (params) => {
      embeddedParams = params;
      return { payloads: [{ text: "## Context (session background)\n- kept" }] };
    },
  });

  const result = await generate({
    conversation: "user: keep this",
    maxInputChars: 100,
    cfg: {
      agents: {
        list: [{ id: "main", model: { primary: "provider/model-name" } }],
      },
    },
    agentId: "main",
    workspaceDir: "/workspace",
    timeoutMs: 1_000,
    thinkLevel: "medium",
    toolErrorSignals: [],
  });

  assert.equal(result.runner, "embedded");
  assert.equal(result.usedFallback, false);
  assert.equal(result.text, "## Context (session background)\n- kept");
  assert.equal(embeddedParams.provider, "provider");
  assert.equal(embeddedParams.model, "model-name");
  assert.equal(embeddedParams.disableTools, true);
});

test("reflection generator returns the structured fallback on embedded failure", async () => {
  const generate = createReflectionTextGenerator({
    diagnosticErrorSummary: (error) => String(error?.message ?? error),
    diagnosticIdentifier: String,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    loadEmbeddedRunner: async () => async () => {
      throw new Error("401 unauthorized");
    },
  });

  const result = await generate({
    conversation: "user: keep this",
    maxInputChars: 100,
    cfg: {},
    agentId: "main",
    workspaceDir: "/workspace",
    timeoutMs: 1_000,
    thinkLevel: "low",
  });

  assert.equal(result.runner, "fallback");
  assert.equal(result.usedFallback, true);
  assert.match(result.error, /embedded:401 unauthorized/);
  assert.match(result.text, /## Learning governance candidates/);
  assert.match(result.text, /## Derived/);
});
