import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  diagnosticContentSummary,
  diagnosticErrorSummary,
  diagnosticIdentifier,
  diagnosticTextSummary,
} = jiti("../src/diagnostic-redaction.ts");

test("diagnostic summaries never emit user text, credentials, identifiers, or paths", () => {
  const canaries = [
    "sk-audit-canary-12345678901234567890",
    "joy@example.invalid",
    "/home/private-user/secret.txt",
    "agent:main:telegram:default:direct:8176453077",
  ];
  const sink = [
    diagnosticTextSummary(canaries.join(" ")),
    diagnosticContentSummary([{ type: "text", text: canaries.join(" ") }]),
    diagnosticErrorSummary(new Error(canaries.join(" "))),
    ...canaries.map((value) => diagnosticIdentifier(value)),
  ].join("\n");

  for (const canary of canaries) assert.equal(sink.includes(canary), false);
  assert.match(sink, /hash=[0-9a-f]{12}/);
  assert.match(sink, /len=/);
});

test("runtime logging paths do not reintroduce raw response or user previews", () => {
  const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const llmSource = readFileSync(new URL("../src/llm-client.ts", import.meta.url), "utf8");
  for (const forbidden of ["summarizeTextPreview", "preview=", "jsonPreview=", "previewText("]) {
    assert.equal(indexSource.includes(forbidden), false, `index.ts contains raw preview marker ${forbidden}`);
    assert.equal(llmSource.includes(forbidden), false, `llm-client.ts contains raw preview marker ${forbidden}`);
  }
});
