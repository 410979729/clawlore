import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createReflectionCommandOrchestrator } = jiti("../src/reflection-command-orchestrator.ts");
const { appendPrivateFile, enforcePrivatePath } = jiti("../src/file-privacy.ts");

const enforcePrivateFile = (path) => enforcePrivatePath(path, { kind: "file" });

const reflectionText = [
  "## Context (session background)",
  "- kept",
  "## Decisions (durable)",
  "- (none captured)",
  "## User model deltas (about the human)",
  "- (none captured)",
  "## Agent model deltas (about the assistant/system)",
  "- (none captured)",
  "## Lessons & pitfalls (symptom / cause / fix / prevention)",
  "- (none captured)",
  "## Learning governance candidates (.learnings / promotion / skill extraction)",
  "- (none captured)",
  "## Open loops / next actions",
  "- (none captured)",
  "## Retrieval tags / keywords",
  "- reflection",
  "## Invariants",
  "- (none captured)",
  "## Derived",
  "- near-term adjustment",
].join("\n");

function baseOptions(overrides = {}) {
  return {
    messageCount: 20,
    maxInputChars: 2_000,
    timeoutMs: 1_000,
    thinkLevel: "medium",
    errorReminderMaxEntries: 3,
    storeToLanceDB: true,
    writeLegacyCombined: true,
    selfImprovementEnabled: false,
    ...overrides,
  };
}

test("reflection command exits before side effects when runtime access is denied", async () => {
  let generated = 0;
  let cleared = 0;
  let pruned = 0;
  const run = createReflectionCommandOrchestrator(baseOptions(), {
    logger: { debug() {}, info() {}, warn() {} },
    resolveRuntimeAccess: () => ({ sourceAgentId: "main", access: { denied: true } }),
    resolveWorkspaceDir: () => "/unused",
    resolveSessionSearchDirs: () => [],
    resolveTargetScope: () => "agent:main",
    getToolErrorSignals: () => [],
    generateReflectionText: async () => { generated += 1; throw new Error("unexpected"); },
    appendSelfImprovementEntry: async () => {},
    enforcePrivateFile,
    appendPrivateFile,
    createReflectionEventId: () => "event",
    embedPassage: async () => [],
    vectorSearch: async () => [],
    storeMemory: async () => ({ timestamp: 1 }),
    storeReflection: async () => ({ slices: { derived: [] } }),
    updateDerivedSession() {},
    clearDerivedSession() {},
    invalidateAgentReflectionCache() {},
    clearReflectionErrorState() { cleared += 1; },
    pruneReflectionState() { pruned += 1; },
    diagnosticErrorSummary: String,
    diagnosticIdentifier: String,
  });

  await run({ sessionKey: "agent:main:telegram:1", context: {} });
  assert.equal(generated, 0);
  assert.equal(cleared, 1);
  assert.equal(pruned, 1);
});

test("reflection command recovers the base session and completes file/store orchestration", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-reflection-command-"));
  try {
    const sessionsDir = join(root, "sessions");
    const sessionFile = join(sessionsDir, "session-1.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "keep this" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "done" } }),
      ].join("\n"),
      "utf8",
    );

    const observed = {
      conversation: "",
      storeParams: null,
      providerInputs: [],
      storedMemories: [],
      derived: null,
      invalidated: "",
      cleared: 0,
      pruned: 0,
    };
    const run = createReflectionCommandOrchestrator(baseOptions(), {
      logger: { debug() {}, info() {}, warn() {} },
      resolveRuntimeAccess: () => ({
        sourceAgentId: "main",
        access: { denied: false, defaultScope: "agent:main" },
      }),
      resolveWorkspaceDir: () => root,
      resolveSessionSearchDirs: () => [sessionsDir],
      resolveTargetScope: (_agentId, access) => access.defaultScope,
      getToolErrorSignals: () => [{
        at: 1,
        toolName: "shell",
        summary: "failed",
        source: "tool_error",
        signature: "failed",
        signatureHash: "abcdef0123456789",
      }],
      generateReflectionText: async (params) => {
        observed.conversation = params.conversation;
        return {
          text: reflectionText.replace(
            "- near-term adjustment",
            "- near-term adjustment [Image attached at: /tmp/clawlore-reflection-private.png]",
          ),
          usedFallback: false,
          promptHash: "hash",
          runner: "embedded",
        };
      },
      appendSelfImprovementEntry: async () => {},
      enforcePrivateFile,
      appendPrivateFile,
      createReflectionEventId: () => "event-1",
      embedPassage: async (text) => {
        observed.providerInputs.push(text);
        return [1, 0];
      },
      vectorSearch: async () => [],
      storeMemory: async (entry) => {
        observed.storedMemories.push(entry);
        return { ...entry, timestamp: 1 };
      },
      storeReflection: async (params) => {
        observed.storeParams = params;
        return { slices: { derived: ["near-term adjustment"] } };
      },
      updateDerivedSession: (sessionKey, runAt, derived) => {
        observed.derived = { sessionKey, runAt, derived };
      },
      clearDerivedSession() {},
      invalidateAgentReflectionCache: (agentId) => { observed.invalidated = agentId; },
      clearReflectionErrorState: () => { observed.cleared += 1; },
      pruneReflectionState: () => { observed.pruned += 1; },
      diagnosticErrorSummary: (error) => String(error?.message ?? error),
      diagnosticIdentifier: String,
    });

    await run({
      action: "reset",
      timestamp: Date.parse("2026-07-17T08:00:00.000Z"),
      sessionKey: "agent:main:telegram:1",
      context: {
        cfg: { agents: { list: [{ id: "main" }] } },
        workspaceDir: root,
        previousSessionEntry: {
          sessionId: "session-1",
          sessionFile: `${sessionFile}.reset.123`,
        },
      },
    });

    assert.equal(observed.conversation, "user: keep this\nassistant: done");
    assert.equal(observed.storeParams.eventId, "event-1");
    assert.equal(observed.storeParams.scope, "agent:main");
    assert.match(observed.storeParams.sourceReflectionPath, /memory[\\/]reflections[\\/]2026-07-17/);
    assert.deepEqual(observed.derived, {
      sessionKey: "agent:main:telegram:1",
      runAt: Date.parse("2026-07-17T08:00:00.000Z"),
      derived: ["near-term adjustment"],
    });
    assert.equal(observed.invalidated, "main");
    assert.equal(observed.cleared, 1);
    assert.ok(observed.pruned >= 2);
    assert.equal(observed.providerInputs.join("\n").includes("clawlore-reflection-private.png"), false);
    assert.equal(JSON.stringify(observed.storedMemories).includes("clawlore-reflection-private.png"), false);

    const reflectionPath = join(root, observed.storeParams.sourceReflectionPath);
    assert.match(await readFile(reflectionPath, "utf8"), /Error Signatures: abcdef0123456789/);
    assert.equal((await readFile(reflectionPath, "utf8")).includes("clawlore-reflection-private.png"), false);
    assert.match(
      await readFile(join(root, "memory", "2026-07-17.md"), "utf8"),
      /Reflection generated:/,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(reflectionPath)).mode & 0o077, 0);
      assert.equal((await stat(join(root, "memory", "2026-07-17.md"))).mode & 0o077, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
