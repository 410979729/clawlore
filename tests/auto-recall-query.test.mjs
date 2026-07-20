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

test("auto-recall query refuses assembled prompt fallback", () => {
  const longPrompt = `  ${"a".repeat(1200)}  `;
  const selection = selectAutoRecallQuery({
    eventPrompt: longPrompt,
    maxChars: 1000,
  });

  assert.equal(selection.source, "empty");
  assert.equal(selection.originalLength, 0);
  assert.equal(selection.truncated, false);
  assert.equal(selection.query, "");
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
    sessionId: "session-user-a",
  };
  const directB = { ...directA, conversationId: "user-b", senderId: "user-b", sessionId: "session-user-b" };
  const group = { ...directA, conversationId: "-1001", senderId: "member-a", sessionId: "session-group-a" };

  cache.remember({ content: "A asks about vector repair" }, directA);
  cache.remember({ content: "B asks about principal isolation" }, directB);
  cache.remember({ content: "Group asks about release gates" }, group);

  assert.equal(cache.select({}, directA, 4_000).query, "A asks about vector repair");
  assert.equal(cache.select({}, directB, 4_000).query, "B asks about principal isolation");
  assert.equal(cache.select({}, group, 4_000).query, "Group asks about release gates");

  cache.clear({}, directB);
  assert.equal(cache.select({}, directA, 4_000).source, "cached-user-message");
  assert.equal(cache.select({}, directB, 4_000).source, "empty");
  assert.equal(cache.select({}, group, 4_000).source, "cached-user-message");
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
  assert.equal(cache.select({}, boundary("user-a"), 4_000).source, "empty");
  assert.equal(cache.select({}, boundary("user-b"), 4_000).query, "second private query");
  assert.equal(cache.select({}, boundary("user-c"), 4_000).query, "third private query");
});

test("auto-recall session cache expires abandoned turns", () => {
  let now = 1_000;
  const cache = new AutoRecallSessionCache(8, 100, () => now);
  const context = {
    channelId: "telegram",
    accountId: "default",
    conversationId: "user-a",
    senderId: "user-a",
  };
  cache.remember({ content: "abandoned query" }, context);
  assert.equal(cache.size(), 1);
  now += 101;
  assert.equal(cache.size(), 0);
  assert.equal(cache.select({}, context, 4_000).source, "empty");
});

test("auto-recall aliases asymmetric hook payloads through the resolved memory boundary", () => {
  const cache = new AutoRecallSessionCache();
  const ingressContext = {
    channelId: "telegram",
    accountId: "default",
    conversationId: "8176453077",
    senderId: "8176453077",
  };
  const promptContext = {
    sessionKey: "agent:main:telegram:default:direct:8176453077",
    sessionId: "session-a",
    runId: "run-a",
  };
  const memoryBoundary = "user:principal-hash";

  cache.remember({ content: "只审计当前插件，不要修改" }, ingressContext, memoryBoundary);
  const first = cache.select({}, promptContext, 4_000, memoryBoundary);
  const duplicate = cache.select({}, promptContext, 4_000, memoryBoundary);

  assert.equal(first.source, "cached-user-message");
  assert.equal(first.query, "只审计当前插件，不要修改");
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.turnKey, first.turnKey);
});

test("same-principal interleaved turns stay bound to their exact sessions", () => {
  const cache = new AutoRecallSessionCache();
  const memoryBoundary = "user:principal-hash";
  const sharedChannel = {
    channelId: "telegram",
    accountId: "default",
    conversationId: "8176453077",
    senderId: "8176453077",
  };

  cache.remember(
    { content: "turn A asks about runtime leases", messageId: "message-a" },
    { ...sharedChannel, sessionId: "session-a" },
    memoryBoundary,
  );
  cache.remember(
    { content: "turn B asks about promotion review", messageId: "message-b" },
    { ...sharedChannel, sessionId: "session-b" },
    memoryBoundary,
  );

  const selectedA = cache.select(
    { messageId: "message-a" },
    { sessionKey: "session-key-a", sessionId: "session-a", runId: "run-a" },
    4_000,
    memoryBoundary,
  );
  const selectedB = cache.select(
    { messageId: "message-b" },
    { sessionKey: "session-key-b", sessionId: "session-b", runId: "run-b" },
    4_000,
    memoryBoundary,
  );

  assert.equal(selectedA.query, "turn A asks about runtime leases");
  assert.equal(selectedB.query, "turn B asks about promotion review");
  assert.equal(selectedA.duplicate, false);
  assert.equal(selectedB.duplicate, false);

  cache.clear({}, { sessionKey: "session-key-a", sessionId: "session-a" }, memoryBoundary);
  assert.equal(cache.select({}, { sessionKey: "session-key-a", sessionId: "session-a" }, 4_000, memoryBoundary).source, "empty");
  assert.equal(cache.select({}, { sessionKey: "session-key-b", sessionId: "session-b", runId: "run-b" }, 4_000, memoryBoundary).query, "turn B asks about promotion review");
  assert.equal(cache.size(), 1);
});

test("reverse prompt order uses exact message identity and retries remain idempotent", () => {
  const cache = new AutoRecallSessionCache();
  const memoryBoundary = "user:principal-hash";
  const context = {
    channelId: "telegram",
    accountId: "default",
    conversationId: "8176453077",
    senderId: "8176453077",
  };
  cache.remember({ content: "first pending turn", messageId: "message-a" }, context, memoryBoundary);
  cache.remember({ content: "second pending turn", messageId: "message-b" }, context, memoryBoundary);

  const second = cache.select(
    { messageId: "message-b" },
    { ...context, sessionId: "session-b", runId: "run-b" },
    4_000,
    memoryBoundary,
  );
  const first = cache.select(
    { messageId: "message-a" },
    { ...context, sessionId: "session-a", runId: "run-a" },
    4_000,
    memoryBoundary,
  );
  const retry = cache.select({}, { sessionId: "session-b", runId: "run-b" }, 4_000, memoryBoundary);

  assert.equal(second.query, "second pending turn");
  assert.equal(first.query, "first pending turn");
  assert.equal(retry.query, "second pending turn");
  assert.equal(retry.duplicate, true);
});

test("interleaved turns without a shared exact id fail closed instead of crossing", () => {
  const cache = new AutoRecallSessionCache();
  const memoryBoundary = "user:principal-hash";
  const ingress = {
    channelId: "telegram",
    accountId: "default",
    conversationId: "8176453077",
    senderId: "8176453077",
  };

  cache.remember({ content: "ambiguous turn A" }, ingress, memoryBoundary);
  cache.remember({ content: "ambiguous turn B" }, ingress, memoryBoundary);

  const promptB = cache.select({}, { sessionKey: "session-b", runId: "run-b" }, 4_000, memoryBoundary);
  const promptA = cache.select({}, { sessionKey: "session-a", runId: "run-a" }, 4_000, memoryBoundary);
  assert.equal(promptB.source, "empty");
  assert.equal(promptB.correlationIssue, "ambiguous_correlation");
  assert.equal(promptA.source, "empty");
  assert.equal(cache.size(), 0);

  cache.remember({ content: "later ordinary turn" }, ingress, memoryBoundary);
  const later = cache.select({}, { sessionKey: "session-c", runId: "run-c" }, 4_000, memoryBoundary);
  assert.equal(later.query, "later ordinary turn");
  assert.equal(later.correlationIssue, undefined);
});

test("ambiguous weak correlation preserves exact aliases for a late exact prompt", () => {
  const cache = new AutoRecallSessionCache();
  const memoryBoundary = "user:principal-hash";
  const ingress = {
    channelId: "telegram",
    accountId: "default",
    conversationId: "8176453077",
    senderId: "8176453077",
  };

  cache.remember({ content: "exact turn A", messageId: "message-a" }, ingress, memoryBoundary);
  cache.remember({ content: "exact turn B", messageId: "message-b" }, ingress, memoryBoundary);

  const ambiguous = cache.select({}, { sessionKey: "unmatched-session", runId: "unmatched-run" }, 4_000, memoryBoundary);
  assert.equal(ambiguous.source, "empty");
  assert.equal(ambiguous.correlationIssue, "ambiguous_correlation");

  const exactA = cache.select({ messageId: "message-a" }, ingress, 4_000, memoryBoundary);
  const exactB = cache.select({ messageId: "message-b" }, ingress, 4_000, memoryBoundary);
  assert.equal(exactA.query, "exact turn A");
  assert.equal(exactB.query, "exact turn B");
});

test("principal correlation hints bridge only pending FIFO and never drive session cleanup", () => {
  const cache = new AutoRecallSessionCache();
  const ingressContext = {
    channelId: "telegram",
    accountId: "default",
    conversationId: "8176453077",
    senderId: "8176453077",
  };
  const memoryBoundary = "user:principal-hash";
  cache.remember({ content: "pending without a session id" }, ingressContext, memoryBoundary);

  const selected = cache.select({}, { sessionId: "session-a", runId: "run-a" }, 4_000, memoryBoundary);
  assert.equal(selected.query, "pending without a session id");
  cache.remember({ content: "another pending turn" }, ingressContext, memoryBoundary);
  cache.clear({}, { sessionId: "session-a" }, memoryBoundary);

  assert.equal(cache.select({}, { sessionId: "session-b", runId: "run-b" }, 4_000, memoryBoundary).query, "another pending turn");
});

test("ending a claimed turn never clears a newer pending message in the same session", () => {
  const cache = new AutoRecallSessionCache();
  const memoryBoundary = "user:principal-hash";
  const sharedContext = {
    channelId: "telegram",
    accountId: "default",
    conversationId: "8176453077",
    senderId: "8176453077",
    sessionId: "session-a",
  };

  cache.remember(
    { content: "turn A is already running", messageId: "message-a" },
    sharedContext,
    memoryBoundary,
  );
  const selectedA = cache.select(
    { messageId: "message-a" },
    { ...sharedContext, runId: "run-a" },
    4_000,
    memoryBoundary,
  );
  assert.equal(selectedA.query, "turn A is already running");

  // A steer-capable host can receive turn B before turn A emits session_end.
  cache.remember(
    { content: "turn B arrived while A was running", messageId: "message-b" },
    sharedContext,
    memoryBoundary,
  );
  cache.clear({}, { ...sharedContext, runId: "run-a" }, memoryBoundary);

  const selectedB = cache.select(
    { messageId: "message-b" },
    { ...sharedContext, runId: "run-b" },
    4_000,
    memoryBoundary,
  );
  assert.equal(selectedB.query, "turn B arrived while A was running");
  assert.equal(selectedB.duplicate, false);
});
