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
  assert.equal(
    buildAutoCaptureConversationKeyFromIngress("telegram", "user-1", "default", "dm"),
    "telegram:default:direct:user-1",
  );
  assert.equal(buildAutoCaptureConversationKeyFromSessionKey("agent:main:telegram:group:topic-2"), "telegram:group:topic-2");
  assert.equal(buildAutoCaptureConversationKeyFromIngress("", "group"), null);
  assert.equal(buildAutoCaptureConversationKeyFromSessionKey("unknown"), null);
});

test("real OpenClaw session keys correlate ingress without crossing agent identities", () => {
  const state = new AutoCaptureSessionState();
  const mainSession = "agent:main:telegram:default:direct:user-real";
  const workerSession = "agent:worker:telegram:default:direct:user-real";
  state.recordIngress({
    channelId: "telegram", accountId: "default", conversationId: "user-real",
    chatType: "direct", sessionKey: mainSession, content: "Main prefers exact session identity",
  });
  state.recordIngress({
    channelId: "telegram", accountId: "default", conversationId: "user-real",
    chatType: "direct", sessionKey: workerSession, content: "Worker prefers separate identity",
  });

  assert.deepEqual(state.consumeAgentEnd({
    sessionKey: mainSession,
    messages: [{ role: "user", content: "Main prefers exact session identity" }],
    captureAssistant: false,
  }).texts, ["Main prefers exact session identity"]);
  assert.deepEqual(state.consumeAgentEnd({
    sessionKey: workerSession,
    messages: [{ role: "user", content: "Worker prefers separate identity" }],
    captureAssistant: false,
  }).texts, ["Worker prefers separate identity"]);
});

test("canonical ingress fallback aligns with the full OpenClaw session suffix", () => {
  const state = new AutoCaptureSessionState();
  state.recordIngress({
    channelId: "telegram", accountId: "default", conversationId: "user-fallback",
    chatType: "direct", content: "Fallback still correlates safely",
  });
  const result = state.consumeAgentEnd({
    sessionKey: "agent:main:telegram:default:direct:user-fallback",
    messages: [{ role: "user", content: "Fallback still correlates safely" }],
    captureAssistant: false,
  });
  assert.deepEqual(result.texts, ["Fallback still correlates safely"]);
  assert.equal(result.pendingIngressCount, 1);
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

test("agent_end consumes only the proven ingress prefix and preserves a steered next message", () => {
  const state = new AutoCaptureSessionState();
  const ingress = (content) => state.recordIngress({
    channelId: "telegram",
    conversationId: "user-steer",
    content,
  });
  assert.equal(ingress("Turn A decided to use SQLite"), true);
  assert.equal(ingress("Turn B decided to use Postgres"), true);

  const endedA = state.consumeAgentEnd({
    sessionKey: "agent:main:telegram:user-steer",
    messages: [{ role: "user", content: "Turn A decided to use SQLite" }],
    captureAssistant: false,
  });
  assert.deepEqual(endedA.texts, ["Turn A decided to use SQLite"]);
  assert.equal(endedA.pendingIngressCount, 1);
  assert.equal(state.inspect().pendingConversations, 1);

  const endedB = state.consumeAgentEnd({
    sessionKey: "agent:main:telegram:user-steer",
    messages: [
      { role: "user", content: "Turn A decided to use SQLite" },
      { role: "user", content: "Turn B decided to use Postgres" },
    ],
    captureAssistant: false,
  });
  assert.deepEqual(endedB.texts, ["Turn B decided to use Postgres"]);
  assert.equal(endedB.pendingIngressCount, 1);
  assert.equal(state.inspect().pendingConversations, 0);
});

test("duplicate ingress text is consumed by multiplicity instead of draining the queue", () => {
  const state = new AutoCaptureSessionState();
  for (let index = 0; index < 2; index += 1) {
    state.recordIngress({
      channelId: "telegram",
      conversationId: "user-duplicate",
      content: "Remember the same preference",
    });
  }
  const first = state.consumeAgentEnd({
    sessionKey: "agent:main:telegram:user-duplicate",
    messages: [{ role: "user", content: "Remember the same preference" }],
    captureAssistant: false,
  });
  assert.deepEqual(first.texts, ["Remember the same preference"]);
  assert.equal(state.inspect().pendingConversations, 1);
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
