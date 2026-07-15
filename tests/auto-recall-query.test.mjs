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
const {
  AutoRecallSessionCache,
  resolveAutoRecallSessionBoundary,
} = jiti("../src/auto-recall-session-boundary.ts");

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

test("auto-recall session cache isolates interleaved Telegram direct and group conversations", () => {
  const cache = new AutoRecallSessionCache();
  const directA = {
    channelId: "telegram",
    accountId: "default",
    conversationId: "user-a",
    senderId: "user-a",
  };
  const directB = { ...directA, conversationId: "user-b", senderId: "user-b" };
  const group = { ...directA, conversationId: "-1001", senderId: "member-a" };

  cache.remember({ content: "A asks about vector repair" }, directA);
  cache.remember({ content: "B asks about principal isolation" }, directB);
  cache.remember({ content: "Group asks about release gates" }, group);

  assert.equal(cache.select({}, directA, "assembled prompt A", 4_000).query, "A asks about vector repair");
  assert.equal(cache.select({}, directB, "assembled prompt B", 4_000).query, "B asks about principal isolation");
  assert.equal(cache.select({}, group, "assembled prompt G", 4_000).query, "Group asks about release gates");

  cache.clear({}, directB);
  assert.equal(cache.select({}, directA, "assembled prompt A", 4_000).source, "cached-user-message");
  assert.equal(cache.select({}, directB, "assembled prompt B", 4_000).source, "event-prompt");
  assert.equal(cache.select({}, group, "assembled prompt G", 4_000).source, "cached-user-message");
  assert.equal(cache.size(), 2);
});

test("auto-recall boundary rejects provider-only keys and prefers stable sessions", () => {
  assert.equal(resolveAutoRecallSessionBoundary({}, { channelId: "telegram" }), undefined);
  assert.equal(
    resolveAutoRecallSessionBoundary({}, { channelId: "telegram", sessionId: "session-a" }),
    "session-id:session-a",
  );
  assert.equal(
    resolveAutoRecallSessionBoundary({}, { sessionKey: "agent:main:telegram:direct:user-a", sessionId: "session-a" }),
    "session-key:agent:main:telegram:direct:user-a",
  );
});

test("auto-recall session cache is bounded and evicts the oldest boundary only", () => {
  const cache = new AutoRecallSessionCache(2);
  const boundary = (id) => ({
    channelId: "telegram",
    accountId: "default",
    conversationId: id,
    senderId: id,
  });
  cache.remember({ content: "first private query" }, boundary("user-a"));
  cache.remember({ content: "second private query" }, boundary("user-b"));
  cache.remember({ content: "third private query" }, boundary("user-c"));

  assert.equal(cache.size(), 2);
  assert.equal(cache.select({}, boundary("user-a"), "fallback A", 4_000).source, "event-prompt");
  assert.equal(cache.select({}, boundary("user-b"), "fallback B", 4_000).query, "second private query");
  assert.equal(cache.select({}, boundary("user-c"), "fallback C", 4_000).query, "third private query");
});
