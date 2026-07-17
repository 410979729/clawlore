import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  AutoCaptureSessionState,
  buildAutoCaptureConversationKeyFromIngress,
  buildAutoCaptureConversationKeyFromSessionKey,
  extractAutoCaptureEligibleTexts,
} = jiti("../src/auto-capture-session-state.ts");

test("conversation keys align ingress and session suffixes without collapsing threads", () => {
  assert.equal(buildAutoCaptureConversationKeyFromIngress(" telegram ", " group:topic-2 "), "telegram:group:topic-2");
  assert.equal(buildAutoCaptureConversationKeyFromSessionKey("agent:main:telegram:group:topic-2"), "telegram:group:topic-2");
  assert.equal(buildAutoCaptureConversationKeyFromIngress("", "group"), null);
  assert.equal(buildAutoCaptureConversationKeyFromSessionKey("unknown"), null);
});

test("message extraction preserves role policy, text blocks, and rejection counts", () => {
  const messages = [
    { role: "user", content: "I prefer dark mode for coding" },
    { role: "assistant", content: "I will remember that preference" },
    { role: "user", content: [{ type: "image", data: "omitted" }, { type: "text", text: "We decided to use SQLite" }] },
    { role: "user", content: "ok" },
    { role: "tool", content: "tool output" },
  ];

  assert.deepEqual(extractAutoCaptureEligibleTexts({ messages, captureAssistant: false }), {
    eligibleTexts: ["I prefer dark mode for coding", "We decided to use SQLite"],
    skippedTextCount: 1,
  });
  assert.deepEqual(
    extractAutoCaptureEligibleTexts({ messages, captureAssistant: true }).eligibleTexts,
    ["I prefer dark mode for coding", "I will remember that preference", "We decided to use SQLite"],
  );
});

test("pending ingress is consumed once and repeated snapshots produce no new texts", () => {
  const state = new AutoCaptureSessionState();
  assert.equal(state.recordIngress({
    channelId: "telegram",
    conversationId: "user-1",
    content: "I prefer green tea every morning",
  }), true);

  const messages = [{ role: "user", content: "old durable preference" }];
  const first = state.consumeAgentEnd({
    sessionKey: "agent:main:telegram:user-1",
    messages,
    captureAssistant: false,
  });
  assert.deepEqual(first.texts, ["I prefer green tea every morning"]);
  assert.equal(first.pendingIngressCount, 1);

  const repeated = state.consumeAgentEnd({
    sessionKey: "agent:main:telegram:user-1",
    messages,
    captureAssistant: false,
  });
  assert.deepEqual(repeated.texts, []);
  assert.equal(repeated.pendingIngressCount, 0);
});

test("history growth selects only new texts and explicit remember carries prior context", () => {
  const state = new AutoCaptureSessionState();
  const sessionKey = "agent:main:telegram:user-2";
  const firstMessage = { role: "user", content: "My deployment preference is blue-green" };

  assert.deepEqual(state.consumeAgentEnd({
    sessionKey,
    messages: [firstMessage],
    captureAssistant: false,
  }).texts, ["My deployment preference is blue-green"]);

  const decision = state.consumeAgentEnd({
    sessionKey,
    messages: [firstMessage, { role: "user", content: "We decided to use canary rollout" }],
    captureAssistant: false,
  });
  assert.deepEqual(decision.texts, ["We decided to use canary rollout"]);

  const remember = state.consumeAgentEnd({
    sessionKey,
    messages: [
      firstMessage,
      { role: "user", content: "We decided to use canary rollout" },
      { role: "user", content: "记住" },
    ],
    captureAssistant: false,
  });
  assert.deepEqual(remember.texts, ["We decided to use canary rollout", "记住"]);
});

test("conversation state remains bounded without exposing captured text", () => {
  const state = new AutoCaptureSessionState({ maxEntries: 2, recentTextLimit: 2 });
  for (const id of ["a", "b", "c"]) {
    state.recordIngress({ channelId: "telegram", conversationId: id, content: `I prefer value ${id}` });
    state.consumeAgentEnd({
      sessionKey: `agent:main:discord:${id}`,
      messages: [{ role: "user", content: `We decided to use value ${id}` }],
      captureAssistant: false,
    });
  }
  assert.deepEqual(state.inspect(), {
    seenSessions: 2,
    pendingConversations: 2,
    recentSessions: 2,
  });
});
