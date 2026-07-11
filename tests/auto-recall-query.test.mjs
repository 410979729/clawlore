import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { cleanUserRecallQuery, selectAutoRecallQuery } = jiti("../src/auto-recall-query.ts");

test("auto-recall query prefers the clean current user message over assembled prompt", () => {
  const selection = selectAutoRecallQuery({
    cachedUserMessage: "@Tianji 修 scope recall 的 hard delete",
    eventPrompt: "System instructions...\nHistory...\nUser: 修 scope recall",
  });

  assert.equal(selection.source, "cached-user-message");
  assert.equal(selection.query, "修 scope recall 的 hard delete");
});

test("auto-recall query falls back to prompt and truncates before embedding", () => {
  const longPrompt = `  ${"a".repeat(1200)}  `;
  const selection = selectAutoRecallQuery({
    eventPrompt: longPrompt,
    maxChars: 1000,
  });

  assert.equal(selection.source, "event-prompt");
  assert.equal(selection.originalLength, 1200);
  assert.equal(selection.truncated, true);
  assert.equal(selection.query.length, 1000);
});

test("cleanUserRecallQuery strips leading bot mentions and compacts whitespace", () => {
  assert.equal(cleanUserRecallQuery("<@12345>   @bot   帮我   看看"), "帮我 看看");
});
