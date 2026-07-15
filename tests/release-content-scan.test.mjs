import assert from "node:assert/strict";
import test from "node:test";

import { scanReleaseText } from "../scripts/release-content-scan.mjs";

test("release content scanner detects secret and host-path canaries without echoing values", () => {
  const privateKey = "-----BEGIN " + "PRIVATE KEY-----";
  const findings = scanReleaseText([
    privateKey,
    "api_key=" + "livecredentialvalue0123456789",
    "/home/realuser/private/config.json",
  ].join("\n"), "fixture.txt");

  assert.deepEqual(findings.map((item) => item.rule), [
    "private-key",
    "credential-assignment",
    "host-user-path",
  ]);
  assert.equal(JSON.stringify(findings).includes("livecredentialvalue"), false);
});

test("release content scanner permits explicit documentation placeholders", () => {
  const findings = scanReleaseText([
    "api_key=YOUR_API_KEY_PLACEHOLDER",
    "token=example-token-not-real",
    "/home/example-user/openclaw/state",
  ].join("\n"), "safe.md");
  assert.deepEqual(findings, []);
});

test("release content scanner does not excuse a real-shaped token merely because it contains a placeholder word", () => {
  const token = `sk-${"a".repeat(20)}test${"b".repeat(20)}`;
  const findings = scanReleaseText(`api_key=${token}`, "dist/runtime.js");
  assert.ok(findings.some((finding) => finding.rule === "openai-key"));
});

test("release content scanner distinguishes detector code from a credential value", () => {
  const findings = scanReleaseText([
    "const secret = matchSecret(sanitized);",
    "const password = resolveCredential(config);",
    "api_key=\"livecredentialvalue0123456789\"",
  ].join("\n"), "dist/runtime.js");

  assert.deepEqual(findings, [
    { path: "dist/runtime.js", rule: "credential-assignment", line: 3 },
  ]);
});
