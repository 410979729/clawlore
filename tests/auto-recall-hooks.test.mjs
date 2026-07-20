import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { registerAutoRecallHooks } = jiti("../src/auto-recall-hooks.ts");

function fixture() {
  const hooks = new Map();
  const db = new DatabaseSync(":memory:");
  const retrievals = [];
  const scope = "user:principal-hash";
  const api = {
    logger: { debug() {}, info() {}, warn() {} },
    on(event, handler) {
      hooks.set(event, handler);
    },
  };
  const access = {
    boundary: { kind: "private", scope, principalHash: "principal-hash" },
    defaultScope: scope,
    scopeFilter: [scope],
    denied: false,
    isAccessible(candidate) {
      return candidate === scope;
    },
  };
  registerAutoRecallHooks({
    api,
    config: {
      autoRecall: true,
      recallMode: "full",
      autoRecallMinLength: 1,
      autoRecallMinRepeated: 0,
      autoRecallMaxItems: 1,
      autoRecallMaxChars: 300,
      autoRecallPerItemMaxChars: 120,
      maxRecallPerTurn: 1,
    },
    retriever: {
      async retrieve(input) {
        retrievals.push(input);
        return [{
          entry: {
            id: "memory-1",
            text: "Use the verified rollback path.",
            category: "fact",
            scope,
            timestamp: 1,
            metadata: JSON.stringify({ state: "confirmed", confidence: 1 }),
          },
          score: 1,
        }];
      },
    },
    store: {
      async getSqlTruthDb() {
        return db;
      },
    },
    scopeManager: {
      getDefaultScope() {
        return scope;
      },
    },
    resolveRuntimeAccess() {
      return { agentId: "main", access };
    },
  });
  return { hooks, db, retrievals };
}

test("asymmetric hooks use the current ingress message and claim one recall per run", async () => {
  const { hooks, db, retrievals } = fixture();
  const ingress = hooks.get("message_received");
  const beforePrompt = hooks.get("before_prompt_build");
  assert.equal(typeof ingress, "function");
  assert.equal(typeof beforePrompt, "function");

  await ingress(
    { content: "只审计当前插件，不要修改", messageId: "39998" },
    {
      channelId: "telegram",
      accountId: "default",
      conversationId: "8176453077",
      senderId: "8176453077",
    },
  );
  const promptEvent = { prompt: "SYSTEM INSTRUCTIONS OLD HISTORY Relevant memories" };
  const promptContext = {
    sessionKey: "agent:main:telegram:default:direct:8176453077",
    sessionId: "session-a",
    runId: "run-a",
  };

  const first = await beforePrompt(promptEvent, promptContext);
  const duplicate = await beforePrompt(promptEvent, promptContext);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(retrievals.length, 1);
  assert.equal(retrievals[0].query, "只审计当前插件，不要修改");
  assert.match(first.prependContext, /Use the verified rollback path/);
  assert.equal(duplicate, undefined);
  const traces = db.prepare("SELECT query_source, query_preview, decision FROM auto_recall_trace_events").all();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].query_source, "cached-user-message");
  assert.match(traces[0].query_preview, /^sha256:[a-f0-9]{16};length=\d+$/);
  assert.equal(traces[0].decision, "injected");
  assert.doesNotMatch(JSON.stringify(traces), /SYSTEM INSTRUCTIONS|只审计当前插件/);
  db.close();
});

test("missing ingress message skips auto-recall instead of embedding assembled prompt", async () => {
  const { hooks, db, retrievals } = fixture();
  const result = await hooks.get("before_prompt_build")(
    { prompt: "SYSTEM INSTRUCTIONS OLD HISTORY Relevant memories" },
    {
      sessionKey: "agent:main:telegram:default:direct:8176453077",
      sessionId: "session-b",
      runId: "run-b",
    },
  );

  assert.equal(result, undefined);
  assert.equal(retrievals.length, 0);
  const schema = db.prepare("SELECT name FROM sqlite_master WHERE name = 'auto_recall_trace_events'").get();
  assert.equal(schema, undefined);
  db.close();
});
