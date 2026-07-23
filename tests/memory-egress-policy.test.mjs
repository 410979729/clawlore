import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  filterUnsafeMemoryResults,
  isMemoryEntrySafeForEgress,
  redactMemoryEntryForOutput,
  redactMemoryTextForOutput,
} = jiti("../src/memory-egress-policy.ts");
const {
  normalizeInlineText,
  sanitizeMemoryForSerialization,
  serializeMemoryEntry,
} = jiti("../src/tool-runtime-policy.ts");
const { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");
const { MemoryUpgrader } = jiti("../src/memory-upgrader.ts");
const { normalizeProviderAnnotation } = jiti("../src/provider-output-policy.ts");

const secret = "synthetic-egress-secret-value-987654";

function entry(id, text, metadata = JSON.stringify({ state: "confirmed", memory_layer: "durable" })) {
  return {
    id,
    text,
    vector: [0.2, 0.4, 0.6],
    category: "fact",
    scope: "agent:test",
    importance: 0.9,
    timestamp: 1_700_000_000_000,
    metadata,
  };
}

function retrievalConfig(patch = {}) {
  return {
    ...DEFAULT_RETRIEVAL_CONFIG,
    mode: "hybrid",
    minScore: 0,
    hardMinScore: 0,
    filterNoise: false,
    recencyWeight: 0,
    lengthNormAnchor: 0,
    timeDecayHalfLifeDays: 0,
    rerank: "none",
    ...patch,
  };
}

test("memory output policy redacts legacy secrets across text and serialized metadata", () => {
  const unsafe = entry("unsafe", `databasePassword: "${secret}"`, JSON.stringify({
    state: "confirmed",
    memory_layer: "durable",
    l0_abstract: `serviceToken: ${secret}`,
  }));
  const safe = entry("safe", "Verified release evidence");

  assert.equal(isMemoryEntrySafeForEgress(unsafe), false);
  assert.equal(isMemoryEntrySafeForEgress(safe), true);
  assert.deepEqual(filterUnsafeMemoryResults([
    { entry: unsafe, score: 1 },
    { entry: safe, score: 0.9 },
  ]).map((result) => result.entry.id), ["safe"]);

  const outputs = [
    redactMemoryTextForOutput(unsafe.text),
    normalizeInlineText(unsafe.text),
    JSON.stringify(sanitizeMemoryForSerialization([{ entry: unsafe, score: 1, sources: {} }])),
    JSON.stringify(serializeMemoryEntry(unsafe, true)),
  ];
  for (const output of outputs) {
    assert.equal(output.includes(secret), false);
    assert.match(output, /REDACTED/);
  }
  assert.equal(JSON.stringify(redactMemoryEntryForOutput(unsafe)).includes(secret), false);
});

test("memory output policy rejects legacy attachment and private-path residue", () => {
  const attachmentPath = "/tmp/clawlore-legacy-private-image.png";
  const attachment = entry(
    "legacy-attachment",
    `Release evidence is required. [Image attached at: ${attachmentPath}]`,
  );
  const privatePath = entry(
    "legacy-private-path",
    "OAuth recovery file is /home/a/.openclaw/oauth/token-cache.json",
  );

  assert.equal(isMemoryEntrySafeForEgress(attachment), false);
  assert.equal(isMemoryEntrySafeForEgress(privatePath), false);
  assert.equal(redactMemoryTextForOutput(attachment.text), "Release evidence is required.");
  assert.equal(redactMemoryTextForOutput(attachment.text).includes(attachmentPath), false);
  assert.equal(redactMemoryTextForOutput(privatePath.text), "[REDACTED_MEMORY_CONTENT]");

  const unsafeMetadata = entry(
    "legacy-metadata-path",
    "Verified release evidence",
    JSON.stringify({ evidence: "OAuth file is /home/a/.openclaw/oauth/token-cache.json" }),
  );
  const injectedMetadata = entry(
    "legacy-metadata-wrapper",
    "Verified release evidence",
    JSON.stringify({ evidence: "OpenClaw runtime context for this turn: raw wrapper" }),
  );
  assert.equal(isMemoryEntrySafeForEgress(unsafeMetadata), false);
  assert.equal(isMemoryEntrySafeForEgress(injectedMetadata), false);
});

test("retrieval keeps secret queries local and filters legacy secret rows before reranking", async () => {
  const safe = entry("safe", "Verified release evidence");
  const unsafe = entry("unsafe", `serviceToken: ${secret}`);
  const calls = { embed: 0, bm25: 0, fetch: 0 };
  let requestBody = "";
  const outboundFetch = async (_url, init) => {
    calls.fetch += 1;
    requestBody = String(init?.body ?? "");
    return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0.99 }] }) };
  };
  const store = {
    hasFtsSupport: true,
    vectorSearch: async () => [{ entry: unsafe, score: 0.99 }, { entry: safe, score: 0.95 }],
    bm25Search: async () => {
      calls.bm25 += 1;
      return [{ entry: unsafe, score: 0.99 }, { entry: safe, score: 0.95 }];
    },
    hasId: async () => true,
  };
  const retriever = new MemoryRetriever(store, {
    embedQuery: async () => {
      calls.embed += 1;
      return [0.2, 0.4, 0.6];
    },
  }, retrievalConfig({
    rerank: "cross-encoder",
    rerankApiKey: "test-placeholder",
    outboundFetch,
  }));

  const safeResults = await retriever.retrieve({ query: "release evidence", limit: 5, source: "manual" });
  assert.deepEqual(safeResults.map((result) => result.entry.id), ["safe"]);
  assert.equal(requestBody.includes(secret), false);

  const secretQuery = `databasePassword: ${secret}`;
  const { results, trace } = await retriever.retrieveWithTrace({ query: secretQuery, limit: 5, source: "manual" });
  assert.deepEqual(results.map((result) => result.entry.id), ["safe"]);
  assert.equal(trace.query.includes(secret), false);
  assert.equal(trace.finalCount, 1);
  assert.equal(calls.embed, 1, "secret query must not invoke the embedder");
  assert.equal(calls.fetch, 1, "secret query must not invoke the reranker");
  assert.equal(calls.bm25 >= 2, true);

  const attachmentQuery = "release evidence [Image attached at: /tmp/clawlore-query-private.png]";
  const attachmentResults = await retriever.retrieve({ query: attachmentQuery, limit: 5, source: "manual" });
  assert.deepEqual(attachmentResults.map((result) => result.entry.id), ["safe"]);
  assert.equal(calls.embed, 1, "attachment-bearing query must not invoke the embedder");
  assert.equal(calls.fetch, 1, "attachment-bearing query must not invoke the reranker");
});

test("legacy upgrader rejects secret rows before any LLM or store mutation", async () => {
  const unsafe = entry("legacy-secret", `Authorization: Bearer ${secret}`, undefined);
  let llmCalls = 0;
  let updateCalls = 0;
  const logs = [];
  const upgrader = new MemoryUpgrader({
    list: async () => [unsafe],
    update: async () => { updateCalls += 1; },
  }, {
    completeJson: async () => { llmCalls += 1; return {}; },
    getLastError: () => null,
  }, { noLlm: false, log: (message) => logs.push(message) });

  const result = await upgrader.upgrade();
  assert.equal(result.upgraded, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(llmCalls, 0);
  assert.equal(updateCalls, 0);
  assert.equal(JSON.stringify({ result, logs }).includes(secret), false);
});

test("legacy upgrader rejects unsafe LLM enrichment and falls back to the safe source", async () => {
  const safeLegacy = entry("legacy-safe", "Release evidence should include targeted regression tests.", undefined);
  const updates = [];
  const upgrader = new MemoryUpgrader({
    list: async () => [safeLegacy],
    update: async (_id, patch) => { updates.push(patch); },
  }, {
    completeJson: async () => ({
      l0_abstract: "Release evidence should include targeted regression tests.",
      l1_overview: "- Preserve targeted regression evidence.",
      l2_content: `serviceToken: ${secret}`,
      resolved_category: "cases",
    }),
    getLastError: () => null,
  }, { noLlm: false, log: () => {} });

  const result = await upgrader.upgrade();
  assert.equal(result.upgraded, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(updates.length, 1);
  assert.equal(JSON.stringify(updates).includes(secret), false);
  assert.match(updates[0].metadata, /Release evidence should include targeted regression tests/);
});

test("provider annotations are bounded and reject secret-bearing output", () => {
  assert.equal(normalizeProviderAnnotation(`databasePassword: ${secret}`), undefined);
  assert.equal(normalizeProviderAnnotation(" same preference\nwith supporting evidence "), "same preference with supporting evidence");
  assert.equal(normalizeProviderAnnotation("x".repeat(500), 32), "x".repeat(32));
});
