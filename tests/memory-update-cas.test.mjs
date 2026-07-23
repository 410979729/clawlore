import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { applyLlmMemoryMergeWithCas } = jiti("../src/llm-memory-merge.ts");
const {
  MemoryUpdateConflictError,
  snapshotMemoryEntry,
} = jiti("../src/memory-store-ports.ts");
const { MemoryStore } = jiti("../src/store.ts");

test("separate store instances reject a stale compare-and-swap update", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-memory-cas-"));
  const first = new MemoryStore({ dbPath: root, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
  const second = new MemoryStore({ dbPath: root, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
  try {
    const created = await first.store({
      text: "Initial durable memory",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "agent:test",
      importance: 0.8,
      metadata: JSON.stringify({ state: "initial" }),
    });
    const stale = await first.getById(created.id, ["agent:test"]);
    assert.ok(stale);

    await second.update(
      created.id,
      { text: "Newer concurrent memory", metadata: JSON.stringify({ state: "newer" }) },
      ["agent:test"],
    );
    await assert.rejects(
      () => first.update(
        created.id,
        { text: "Late stale overwrite", metadata: JSON.stringify({ state: "stale" }) },
        ["agent:test"],
        { expected: snapshotMemoryEntry(stale) },
      ),
      (error) => error?.code === "CLAWLORE_MEMORY_UPDATE_CONFLICT",
    );
    const final = await first.getById(created.id, ["agent:test"]);
    assert.equal(final?.text, "Newer concurrent memory");
    assert.equal(JSON.parse(final?.metadata ?? "{}").state, "newer");
  } finally {
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("LLM merge retries against the latest revision instead of overwriting it", async () => {
  const base = {
    id: "10000000-0000-4000-8000-000000000001",
    text: "Initial profile",
    vector: [],
    category: "fact",
    scope: "agent:test",
    importance: 0.8,
    timestamp: 1,
    metadata: JSON.stringify({ state: "initial" }),
  };
  let current = base;
  let updates = 0;
  const prompts = [];
  const result = await applyLlmMemoryMergeWithCas({
    memoryId: base.id,
    scopeFilter: ["agent:test"],
    store: {
      async getById() {
        return current;
      },
      async update(_id, patch, _scope, options) {
        updates += 1;
        if (updates === 1) {
          current = {
            ...current,
            text: "Newer concurrent profile",
            metadata: JSON.stringify({ state: "newer" }),
          };
          throw new MemoryUpdateConflictError();
        }
        assert.deepEqual(options.expected, snapshotMemoryEntry(current));
        current = { ...current, ...patch };
        return current;
      },
    },
    async completeJson(prompt) {
      prompts.push(prompt);
      return {
        abstract: `${prompt} plus candidate`,
        overview: "Merged against the currently durable revision.",
        content: `${prompt} plus the newly observed candidate detail.`,
      };
    },
    async embed() {
      return [0.1, 0.2, 0.3, 0.4];
    },
    buildPrompt(existing) {
      return existing.text;
    },
    buildUpdates(_existing, payload, vector) {
      return {
        text: payload.abstract,
        vector,
        metadata: JSON.stringify({ state: "merged" }),
      };
    },
  });

  assert.equal(result.status, "merged");
  assert.deepEqual(prompts, ["Initial profile", "Newer concurrent profile"]);
  assert.equal(updates, 2);
  assert.equal(current.text, "Newer concurrent profile plus candidate");
});
