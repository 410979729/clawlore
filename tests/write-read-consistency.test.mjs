import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
const { buildSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");
const { MemoryStore } = jiti("../src/store.ts");

const canaryText =
  "CLAWLORE-RECALL-CANARY-6542-SILVER-ORBIT means the production memory tool path passed.";

test("a confirmed manual write is immediately visible to exact lexical recall", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-write-read-"));
  const store = new MemoryStore({
    dbPath: root,
    vectorDim: 4,
    vectorBackend: "sqlite-bruteforce",
  });
  const embedder = {
    embedPassage: async () => [1, 0, 0, 0],
    embedQuery: async () => [1, 0, 0, 0],
  };
  const retriever = new MemoryRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    mode: "hybrid",
    rerank: "none",
    filterNoise: true,
    recencyWeight: 0,
    lengthNormAnchor: 0,
    timeDecayHalfLifeDays: 0,
  });

  try {
    const stored = await store.store({
      text: canaryText,
      vector: await embedder.embedPassage(canaryText),
      category: "fact",
      scope: "user:write-read-canary",
      importance: 0.7,
      metadata: stringifySmartMetadata(buildSmartMetadata({
        text: canaryText,
        category: "fact",
        importance: 0.7,
      }, {
        l0_abstract: canaryText,
        l1_overview: `- ${canaryText}`,
        l2_content: canaryText,
        state: "confirmed",
        source: "manual",
      })),
    });

    const truth = await store.getById(stored.id, ["user:write-read-canary"]);
    assert.equal(truth?.text, canaryText);

    const results = await retriever.retrieve({
      query: "SILVER-ORBIT",
      limit: 3,
      scopeFilter: ["user:write-read-canary"],
      source: "manual",
    });
    assert.equal(results[0]?.entry.id, stored.id);
    assert.equal(results[0]?.entry.text, canaryText);
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
