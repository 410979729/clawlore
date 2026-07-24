import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import {
  ALLOWED_PLATFORM_VARIANCE,
  stableReleaseEvidenceMatches,
} from "../scripts/release-evidence-contract.mjs";

const CLI_SOURCE_FILES = [
  "../cli.ts",
  "../src/cli/auth-commands.ts",
  "../src/cli/auth-config-transaction.ts",
  "../src/cli/memory-commands.ts",
  "../src/cli/diagnostic-commands.ts",
  "../src/cli/governance-commands.ts",
  "../src/cli/experience-commands.ts",
  "../src/cli/migration-commands.ts",
];

function readClawLoreCliSources() {
  return CLI_SOURCE_FILES
    .map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"))
    .join("\n");
}

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { registerAllMemoryTools } = jiti("../src/tools.ts");
const { EXPERIENCE_TOOL_NAMES } = jiti("../src/experience-tools.ts");
const { buildSecretIndex } = jiti("../src/secret-index.ts");
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { storeReflectionToLanceDB } = jiti("../src/reflection-store.ts");
const { resolveRuntimeMemoryAccess } = jiti("../src/runtime-memory-boundary.ts");
const { parseRuntimePluginConfig } = jiti("../src/plugin-config.ts");

function fail(message) {
  throw new Error(message);
}

function createToolMap(toolCtx = {}, options = {}) {
  const tools = new Map();
  const api = {
    registerTool(factory, meta) {
      tools.set(meta.name, factory(toolCtx));
    },
  };
  const context = {
    retriever: { retrieve: () => fail("retriever should not run without agent context") },
    store: {
      getById: () => fail("store should not run without agent context"),
      list: () => fail("store should not run without agent context"),
      patchMetadata: () => fail("store should not run without agent context"),
      store: () => fail("store should not run without agent context"),
      update: () => fail("store should not run without agent context"),
      vectorSearch: () => fail("store should not run without agent context"),
    },
    scopeManager: {
      getDefaultScope: () => fail("scope default should not run without agent context"),
      getScopeFilter: () => fail("scope filter should not run without agent context"),
      isAccessible: () => fail("scope access should not run without agent context"),
    },
    embedder: { embedPassage: () => fail("embedder should not run without agent context") },
  };
  registerAllMemoryTools(api, context, {
    enableManagementTools: true,
    enableSelfImprovementTools: false,
    secretIndexToolsEnabled: options.secretIndexToolsEnabled === true,
  });
  return tools;
}

function createWritableToolMap(toolCtx = {}, options = {}) {
  const tools = new Map();
  const stored = [];
  const retrieved = [];
  const embedded = [];
  const api = {
    registerTool(factory, meta) {
      tools.set(meta.name, factory(toolCtx));
    },
  };
  const context = {
    retriever: {
      async retrieve(params) {
        retrieved.push(params);
        return [];
      },
    },
    store: {
      getById: async () => null,
      list: async () => [],
      patchMetadata: async () => null,
      async store(entry) {
        stored.push(entry);
        return {
          ...entry,
          id: `mem-${stored.length}`,
          timestamp: 1_700_000_000_000 + stored.length,
        };
      },
      update: async () => null,
      vectorSearch: options.vectorSearch ?? (async () => []),
    },
    scopeManager: {
      getDefaultScope(agentId) {
        return `agent:${agentId}`;
      },
      getScopeFilter(agentId) {
        return [`agent:${agentId}`, "global"];
      },
      isAccessible(scope, agentId) {
        return scope === "global" || scope === `agent:${agentId}`;
      },
    },
    embedder: {
      async embedPassage(text) {
        embedded.push(text);
        return [0.1, 0.2, 0.3];
      },
    },
    workspaceDir: "/workspace/default",
    principalIsolation: options.principalIsolation,
  };
  registerAllMemoryTools(api, context, {
    enableManagementTools: true,
    enableSelfImprovementTools: false,
    secretIndexToolsEnabled: options.secretIndexToolsEnabled === true,
  });
  return { tools, stored, retrieved, embedded };
}

function createSystemBypassToolMap() {
  const tools = new Map();
  const readScopes = [];
  const writeScopes = [];
  const entry = {
    id: "90000000-0000-4000-8000-000000000001",
    text: "system bypass fixture",
    vector: [],
    category: "fact",
    scope: "agent:main",
    importance: 1,
    timestamp: 1,
    metadata: "{}",
  };
  const api = {
    registerTool(factory, meta) {
      tools.set(meta.name, factory({ agentId: "system" }));
    },
  };
  const context = {
    retriever: {
      async retrieve(params) {
        readScopes.push(["retrieve", params.scopeFilter]);
        return [];
      },
      async retrieveWithTrace(params) {
        readScopes.push(["debug", params.scopeFilter]);
        return { results: [], trace: { mode: "hybrid", totalMs: 0, stages: [] } };
      },
    },
    store: {
      async list(scopeFilter) {
        readScopes.push(["list", scopeFilter]);
        return [];
      },
      async getById(_id, scopeFilter) {
        readScopes.push(["getById", scopeFilter]);
        return entry;
      },
      async patchMetadata(_id, _patch, scopeFilter) {
        writeScopes.push(scopeFilter);
        return entry;
      },
      async store() { return entry; },
      async update() { return entry; },
      async vectorSearch() { return []; },
    },
    scopeManager: {
      getScopeFilter() { return undefined; },
      getDefaultScope() { throw new Error("system bypass must not resolve a default write scope"); },
      isAccessible() { return true; },
    },
    embedder: { embedPassage: async () => [0.1, 0.2, 0.3] },
    principalIsolation: { enabled: false },
  };
  registerAllMemoryTools(api, context, {
    enableManagementTools: true,
    enableSelfImprovementTools: false,
  });
  return { tools, readScopes, writeScopes, entry };
}

test("different private principals receive disjoint scopes and only an allowlisted owner can read legacy agent scope", () => {
  const scopeManager = {
    getDefaultScope: (agentId) => `agent:${agentId}`,
    getAccessibleScopes: (agentId) => [`agent:${agentId}`, "global"],
    getScopeFilter: (agentId) => [`agent:${agentId}`, "global"],
    isAccessible: (scope, agentId) => scope === `agent:${agentId}` || scope === "global",
  };
  const owner = resolveRuntimeMemoryAccess({
    scopeManager,
    agentId: "main",
    config: { legacyAgentScopePrincipals: ["telegram:default:8176453077"] },
    runtimeContext: { sessionKey: "agent:main:telegram:default:direct:8176453077" },
  });
  const stranger = resolveRuntimeMemoryAccess({
    scopeManager,
    agentId: "main",
    config: { legacyAgentScopePrincipals: ["telegram:default:8176453077"] },
    runtimeContext: { sessionKey: "agent:main:telegram:default:direct:999" },
  });
  assert.notEqual(owner.defaultScope, stranger.defaultScope);
  assert.equal(owner.isAccessible("agent:main"), true);
  assert.equal(stranger.isAccessible("agent:main"), false);
  assert.equal(owner.isAccessible(stranger.defaultScope), false);
  assert.equal(stranger.isAccessible(owner.defaultScope), false);
});

test("runtime parsing asserts OpenClaw SecretRef materialization before strict config parsing", () => {
  const parsed = parseRuntimePluginConfig({ embedding: { provider: "local-hash" } });
  assert.equal(parsed.embedding.provider, "local-hash");

  assert.throws(
    () => parseRuntimePluginConfig({
      embedding: {
        provider: "openai-compatible",
        apiKey: { source: "file", provider: "runtime", id: "embedding" },
      },
    }),
    /did not resolve manifest-declared runtime SecretRefs before registration: embedding\.apiKey/,
  );
});

test("system bypass stays unfiltered for read tools and requires explicit scopes for writes", async () => {
  const { tools, readScopes, writeScopes, entry } = createSystemBypassToolMap();
  const signal = new AbortController().signal;
  const runtime = { agentId: "system" };
  await tools.get("memory_debug").execute("call", { query: "fixture" }, signal, undefined, runtime);
  await tools.get("memory_list").execute("call", {}, signal, undefined, runtime);
  await tools.get("memory_context").execute("call", {}, signal, undefined, runtime);
  await tools.get("memory_inspect").execute("call", { memoryId: entry.id }, signal, undefined, runtime);
  await tools.get("memory_govern").execute("call", {}, signal, undefined, runtime);
  assert.equal(readScopes.length, 5);
  for (const [tool, scopeFilter] of readScopes) {
    assert.equal(scopeFilter, undefined, tool);
  }

  for (const name of ["memory_promote", "memory_archive"]) {
    const denied = await tools.get(name).execute(
      "call",
      { memoryId: entry.id },
      signal,
      undefined,
      runtime,
    );
    assert.equal(denied.details.error, "explicit_scope_required", name);
    const allowed = await tools.get(name).execute(
      "call",
      { memoryId: entry.id, scope: "agent:main" },
      signal,
      undefined,
      runtime,
    );
    assert.equal(allowed.details.id, entry.id, name);
  }
  assert.deepEqual(writeScopes, [["agent:main"], ["agent:main"]]);
});

test("group boundary denies all core memory tools before retrieval, embedding, or DB writes", async () => {
  const { tools, stored, retrieved } = createWritableToolMap();
  const runtime = {
    agentId: "main",
    sessionKey: "agent:main:telegram:default:group:-100123",
    channelId: "telegram",
    accountId: "default",
    conversationId: "-100123",
    chatType: "group",
    senderId: "untrusted-member",
  };
  const cases = [
    ["memory_recall", { query: "private preference" }],
    ["memory_store", { text: "poison the shared memory" }],
    ["memory_update", { memoryId: "11111111-1111-1111-1111-111111111111", text: "change it" }],
    ["memory_forget", { query: "delete private preference", confirm: true }],
  ];
  for (const [name, params] of cases) {
    const result = await tools.get(name).execute("test-call", params, undefined, undefined, runtime);
    assert.equal(result.details.error, "memory_boundary_denied", name);
    assert.equal(result.details.reason, "group_memory_denied", name);
  }
  assert.equal(retrieved.length, 0);
  assert.equal(stored.length, 0);
});

test("core memory tools fail closed when OpenClaw agent context is missing", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const tools = createToolMap();
    const calls = [
      ["memory_recall", { query: "anything" }],
      ["memory_store", { text: "remember this" }],
      ["memory_forget", { query: "anything" }],
      ["memory_update", { memoryId: "memory-id", importance: 0.5 }],
    ];

    for (const [name, params] of calls) {
      const result = await tools.get(name).execute("test-call", params);
      assert.equal(result.details.error, "missing_agent_context", name);
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("secret index tool is hidden by default and fail-closed when explicitly enabled without agent context", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const defaultTools = createToolMap();
    assert.equal(defaultTools.has("memory_store_secret_index"), false);

    const enabledTools = createToolMap({}, { secretIndexToolsEnabled: true });
    assert.equal(enabledTools.has("memory_store_secret_index"), true);
    const result = await enabledTools
      .get("memory_store_secret_index")
      .execute("test-call", { label: "deploy credential", vaultRef: "op://infra/deploy/password" });
    assert.equal(result.details.error, "missing_agent_context");
  } finally {
    console.warn = originalWarn;
  }
});

test("secret index rejects plaintext secrets in free-text metadata fields", () => {
  assert.throws(
    () => buildSecretIndex({
      label: "prod api key",
      vaultRef: "op://infra/prod-api-key/password",
      notes: "temporary value sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
    }),
    /secret index field 'notes' rejected/,
  );

  const safe = buildSecretIndex({
    label: "prod api key",
    vaultRef: "op://infra/prod-api-key/password",
    notes: "Stored in external vault only.",
    secretFingerprintSha256: "a".repeat(64),
  });
  assert.match(safe.content, /Plaintext secret value: \[never accepted by ClawLore\]/);
  assert.match(safe.content, /Secret fingerprint: sha256:aaaaaaaaaaaaaaaa/);
  assert.doesNotMatch(safe.content, /sk-proj-/);
  assert.throws(
    () => buildSecretIndex({ label: "invalid digest", secretFingerprintSha256: "plaintext-secret" }),
    /locally generated 64-character SHA-256 digest/,
  );
  assert.throws(
    () => buildSecretIndex({
      label: "entity boundary",
      entities: ['{"databasePassword":"synthetic-entity-value"}'],
    }),
    /secret index field 'entities' rejected/,
  );
  assert.throws(
    () => buildSecretIndex({
      label: "tag boundary",
      tags: ["Authorization: Digest synthetic-tag-credential-material"],
    }),
    /secret index field 'tags' rejected/,
  );
});

test("memory_store persists deterministic runtime scope metadata", async () => {
  const { tools, stored } = createWritableToolMap({ workspaceDir: "/workspace/static" });
  const sessionKey = "agent:main:telegram:default:direct:8176453077";
  const result = await tools.get("memory_store").execute(
    "test-call",
    {
      text: "OpenClaw release audits must include targeted regression tests.",
      category: "fact",
      importance: 0.83,
    },
    undefined,
    undefined,
    {
      agentId: "main",
      sessionKey,
      sessionId: "session-123",
      channelId: "telegram",
      accountId: "default",
      conversationId: "8176453077",
      threadId: "direct",
      platform: "telegram",
      workspaceDir: "/workspace/runtime",
    },
  );

  assert.equal(result.details.action, "created");
  assert.equal(stored.length, 1);
  const metadata = JSON.parse(stored[0].metadata);
  const expectedScope = `user:${createHash("sha256").update("telegram:default:8176453077").digest("hex").slice(0, 32)}`;
  assert.equal(stored[0].scope, expectedScope);
  assert.equal(metadata.runtime_contract, "openclaw-scope-v1");
  assert.equal(metadata.agentId, "main");
  assert.equal(metadata.agent_id, "main");
  assert.equal(metadata.scope_owner_agent_id, "main");
  assert.equal(metadata.sessionKey, sessionKey);
  assert.equal(metadata.session_key, sessionKey);
  assert.equal(metadata.source_session, sessionKey);
  assert.equal(metadata.session_id, "session-123");
  assert.equal(metadata.channel_id, "telegram");
  assert.equal(metadata.account_id, "default");
  assert.equal(metadata.conversation_id, "8176453077");
  assert.equal(metadata.thread_id, "direct");
  assert.equal(metadata.workspace_bound, true);
  assert.equal("workspace_dir" in metadata, false);
  assert.equal(JSON.stringify(metadata).includes("/workspace/runtime"), false);
  assert.equal(metadata.scope_id, expectedScope);
  assert.deepEqual(metadata.scope_filter, [expectedScope]);
  assert.equal(metadata.scope_filter_mode, "restricted");
  assert.equal(metadata.memory_boundary, "private");
  assert.equal(metadata.principal_hash.length, 16);
  assert.equal(metadata.dedup_skipped, false);
});

test("memory_store records when its fail-open duplicate precheck was unavailable", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { tools, stored } = createWritableToolMap({}, {
      vectorSearch: async () => { throw new Error("vector lane unavailable"); },
    });
    const result = await tools.get("memory_store").execute(
      "test-call",
      { text: "Record dedup precheck availability in memory metadata." },
      undefined,
      undefined,
      { agentId: "main", sessionKey: "agent:main:telegram:default:direct:8176453077" },
    );
    assert.equal(result.details.action, "created");
    assert.equal(result.details.dedupSkipped, true);
    assert.equal(JSON.parse(stored[0].metadata).dedup_skipped, true);
  } finally {
    console.warn = originalWarn;
  }
});

test("memory_store denies inaccessible scopes before embedding or storing", async () => {
  const { tools, stored } = createWritableToolMap();
  const result = await tools.get("memory_store").execute(
    "test-call",
    {
      text: "This should never be stored in another agent scope.",
      category: "fact",
      scope: "agent:other",
    },
    undefined,
    undefined,
    {
      agentId: "main",
      sessionKey: "agent:main:telegram:default:direct:8176453077",
    },
  );

  assert.equal(result.details.error, "scope_access_denied");
  assert.equal(stored.length, 0);
});

test("memory_update rejects secret-bearing text before provider embedding", async () => {
  const { tools, embedded, stored } = createWritableToolMap();
  const result = await tools.get("memory_update").execute(
    "test-call",
    {
      memoryId: "11111111-1111-1111-1111-111111111111",
      text: "databasePassword: SyntheticUpdateSecret123",
    },
    undefined,
    undefined,
    {
      agentId: "main",
      sessionKey: "agent:main:telegram:default:direct:8176453077",
    },
  );

  assert.equal(result.details.action, "capture_safety_filtered");
  assert.equal(embedded.length, 0);
  assert.equal(stored.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /SyntheticUpdateSecret123/u);
});

test("memory_recall denies inaccessible scopes before retrieval", async () => {
  const { tools, retrieved } = createWritableToolMap();
  const result = await tools.get("memory_recall").execute(
    "test-call",
    {
      query: "release audit preferences",
      scope: "agent:other",
    },
    undefined,
    undefined,
    {
      agentId: "main",
      sessionKey: "agent:main:telegram:default:direct:8176453077",
    },
  );

  assert.equal(result.details.error, "scope_access_denied");
  assert.equal(retrieved.length, 0);
});

test("smart extraction persists runtime scope metadata on auto-captured memories", async () => {
  const stored = [];
  const providerInputs = [];
  const store = {
    vectorSearch: async () => [],
    async store(entry) {
      stored.push(entry);
      return { ...entry, id: `auto-${stored.length}`, timestamp: Date.now() };
    },
    getById: async () => null,
    update: async () => null,
  };
  const embedder = {
    embed: async (text) => {
      providerInputs.push(text);
      return [0.4, 0.5, 0.6];
    },
  };
  const llm = {
    async completeJson(prompt, label) {
      providerInputs.push(prompt);
      if (label === "extract-candidates") {
        return {
          memories: [
            {
              category: "cases",
              abstract: "Release audits require targeted regression tests.",
              overview: "- Targeted tests should accompany release audits.",
              content: "OpenClaw release audits should include targeted regression tests before the release gate.",
            },
          ],
        };
      }
      return null;
    },
    getLastError: () => null,
  };
  const extractor = new SmartExtractor(store, embedder, llm, {
    defaultScope: "agent:main",
    log: () => {},
    debugLog: () => {},
  });
  const sessionKey = "agent:main:telegram:default:direct:8176453077";

  const stats = await extractor.extractAndPersist(
    "Joy said OpenClaw release audits should include targeted regression tests.\n[Image attached at: /tmp/clawlore-private-audit.png]",
    sessionKey,
    {
      scope: "agent:main",
      scopeFilter: ["agent:main", "global"],
      runtimeMetadata: {
        runtime_contract: "openclaw-scope-v1",
        agentId: "main",
        agent_id: "main",
        source_session: sessionKey,
        channel_id: "telegram",
        scope_id: "agent:main",
        scope_filter: ["agent:main", "global"],
        scope_filter_mode: "restricted",
      },
    },
  );

  assert.equal(stats.created, 1);
  assert.equal(stored.length, 1);
  const metadata = JSON.parse(stored[0].metadata);
  assert.equal(metadata.runtime_contract, "openclaw-scope-v1");
  assert.equal(metadata.agentId, "main");
  assert.equal(metadata.agent_id, "main");
  assert.equal(metadata.source_session, sessionKey);
  assert.equal(metadata.channel_id, "telegram");
  assert.equal(metadata.scope_id, "agent:main");
  assert.deepEqual(metadata.scope_filter, ["agent:main", "global"]);
  assert.equal(metadata.scope_filter_mode, "restricted");
  assert.equal(providerInputs.join("\n").includes("clawlore-private-audit.png"), false);
});

test("smart extraction keeps unsafe noise inputs and invalid provider fields out of providers and logs", async () => {
  const syntheticValue = "SyntheticInvalidProviderValue7788";
  const embedded = [];
  const logs = [];
  const extractor = new SmartExtractor(
    {
      vectorSearch: async () => [],
      store: async () => fail("invalid candidates must not be stored"),
      getById: async () => null,
      update: async () => null,
    },
    {
      async embed(text) {
        embedded.push(text);
        return [0.1, 0.2, 0.3];
      },
    },
    {
      async completeJson() {
        return {
          memories: [{
            category: `databasePassword: ${syntheticValue}`,
            abstract: `private ${syntheticValue}`,
            overview: "invalid provider output",
            content: "invalid provider output must be rejected",
          }],
        };
      },
      getLastError: () => null,
    },
    {
      defaultScope: "agent:main",
      log: (message) => logs.push(message),
      debugLog: (message) => logs.push(message),
      noiseBank: {
        initialized: true,
        isNoise: () => false,
      },
    },
  );

  const safeTexts = await extractor.filterNoiseByEmbedding([
    "Release verification is required. [Image attached at: /tmp/clawlore-noise-private.png]",
    `databasePassword: ${syntheticValue}`,
  ]);
  assert.deepEqual(safeTexts, ["Release verification is required."]);
  assert.equal(embedded.length, 1);
  assert.doesNotMatch(embedded.join("\n"), /clawlore-noise-private|SyntheticInvalidProviderValue/u);

  const stats = await extractor.extractAndPersist(
    "Release verification must run before updating the repository version.",
    "agent:main:telegram:default:direct:8176453077",
  );
  assert.equal(stats.created, 0);
  assert.doesNotMatch(logs.join("\n"), /SyntheticInvalidProviderValue/u);
});

test("reflection embeddings exclude direct runtime session identifiers", async () => {
  const sessionKey = "agent:main:telegram:default:direct:8176453077";
  const sessionId = "session-private-123";
  const scope = "user:direct-principal-private";
  const embedded = [];
  const stored = [];

  const result = await storeReflectionToLanceDB({
    reflectionText: [
      "## Invariants",
      "- Release audits require independent regression evidence.",
      "",
      "## Derived",
      "- Keep provider-bound semantic text free of runtime identifiers.",
    ].join("\n"),
    sessionKey,
    sessionId,
    agentId: "main",
    command: "new",
    scope,
    toolErrorSignals: [],
    runAt: 1_700_000_000_000,
    usedFallback: false,
    async embedPassage(text) {
      embedded.push(text);
      return [0.1, 0.2, 0.3];
    },
    vectorSearch: async () => [],
    async store(entry) {
      stored.push(entry);
      return { ...entry, id: `reflection-${stored.length}`, timestamp: 1_700_000_000_000 };
    },
  });

  assert.equal(result.stored, true);
  assert.ok(embedded.length > 0);
  for (const text of embedded) {
    assert.doesNotMatch(text, new RegExp(sessionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.doesNotMatch(text, new RegExp(sessionId, "u"));
    assert.doesNotMatch(text, new RegExp(scope, "u"));
  }
  assert.equal(JSON.parse(stored[0].metadata).sessionKey, sessionKey);
});

test("smart merge rejects unsafe provider output before embedding or update", async () => {
  const syntheticValue = ["clawlore", "audit", "only", "merge", "value"].join("-");
  const stored = [];
  const updated = [];
  const embedded = [];
  const logs = [];
  const existing = {
    id: "10000000-0000-4000-8000-000000000001",
    text: "Joy prefers concise release reports.",
    vector: [0.2, 0.3, 0.4],
    category: "preference",
    scope: "agent:main",
    importance: 0.8,
    timestamp: 1_700_000_000_000,
    metadata: JSON.stringify({
      memory_category: "preferences",
      l0_abstract: "Joy prefers concise release reports.",
      l1_overview: "- Reports should stay concise.",
      l2_content: "Joy prefers concise release reports with verification evidence.",
    }),
  };
  const store = {
    vectorSearch: async () => [{ entry: existing, score: 0.95 }],
    getById: async () => existing,
    async store(entry) {
      stored.push(entry);
      return { ...entry, id: `merge-fallback-${stored.length}`, timestamp: Date.now() };
    },
    async update(id, patch) {
      updated.push({ id, patch });
      return { ...existing, ...patch };
    },
  };
  const embedder = {
    async embed(text) {
      embedded.push(text);
      return [0.4, 0.5, 0.6];
    },
  };
  const llm = {
    async completeJson(_prompt, label) {
      if (label === "extract-candidates") {
        return {
          memories: [{
            category: "preferences",
            abstract: "Joy prefers concise audited release reports.",
            overview: "- Keep release reports concise and evidence-backed.",
            content: "Joy prefers concise release reports that include concrete audit evidence.",
          }],
        };
      }
      if (label === "dedup-decision") {
        return { decision: "merge", reason: "same preference", match_index: 1 };
      }
      if (label === "merge-memory") {
        return {
          abstract: "Joy prefers concise audited release reports.",
          overview: "- Keep release reports concise and evidence-backed.",
          content: `databasePassword: ${syntheticValue}`,
        };
      }
      return null;
    },
    getLastError: () => null,
  };
  const extractor = new SmartExtractor(store, embedder, llm, {
    defaultScope: "agent:main",
    log: (message) => logs.push(message),
    debugLog: () => {},
  });

  const stats = await extractor.extractAndPersist(
    "Joy prefers concise release reports with concrete audit evidence.",
    "agent:main:telegram:default:direct:8176453077",
    { scope: "agent:main", scopeFilter: ["agent:main", "global"] },
  );

  assert.equal(stats.created, 1);
  assert.equal(stats.merged, 0);
  assert.equal(stored.length, 1);
  assert.equal(updated.length, 0);
  assert.equal(embedded.some((text) => text.includes(syntheticValue)), false);
  assert.equal(JSON.stringify(stored).includes(syntheticValue), false);
  assert.equal(logs.join("\n").includes(syntheticValue), false);
});

test("operator schemas include rejected memory state", () => {
  const tools = createToolMap({ agentId: "audit-agent" });
  for (const name of ["memory_context", "memory_promote"]) {
    const stateSchema = tools.get(name).parameters.properties.state;
    const values = stateSchema.anyOf.map((item) => item.const);
    assert.ok(values.includes("rejected"), name);
  }
});

test("manifest declares all owned tools and marks management tools with config availability", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.ok(manifest.contracts.tools.includes("memory_recall"));
  assert.ok(manifest.contracts.tools.includes("memory_store_secret_index"));
  assert.ok(manifest.contracts.tools.includes("memory_govern"));
  assert.ok(manifest.contracts.tools.includes("self_improvement_review"));

  for (const toolName of ["memory_store", "memory_forget", "memory_update"]) {
    const writeSignal = manifest.toolMetadata[toolName].configSignals[0];
    assert.equal(writeSignal.rootPath, "plugins.entries.clawlore.config");
    assert.equal(writeSignal.mode.path, "agentToolProfile");
    assert.equal(writeSignal.mode.default, "memory-write");
    assert.deepEqual(writeSignal.mode.allowed, [
      ...(toolName === "memory_store" ? ["v2-write"] : []),
      "memory-write",
      "self-improvement",
      "operator",
      "operator-secret-index",
    ]);
  }

  const secretSignal = manifest.toolMetadata.memory_store_secret_index.configSignals[0];
  assert.equal(secretSignal.rootPath, "plugins.entries.clawlore.config");
  assert.equal(secretSignal.mode.path, "agentToolProfile");
  assert.deepEqual(secretSignal.mode.allowed, ["operator-secret-index"]);

  const governSignal = manifest.toolMetadata.memory_govern.configSignals[0];
  assert.equal(governSignal.rootPath, "plugins.entries.clawlore.config");
  assert.equal(governSignal.mode.path, "agentToolProfile");
  assert.deepEqual(governSignal.mode.allowed, ["operator", "operator-secret-index"]);

  const alwaysAvailableExperienceTools = new Set([
    "scope_recall_playbook_search",
    "scope_recall_playbook_inspect",
    "scope_recall_experience_preflight",
  ]);
  for (const toolName of EXPERIENCE_TOOL_NAMES) {
    assert.ok(manifest.contracts.tools.includes(toolName), `${toolName} contract missing`);
    assert.equal(
      manifest.toolMetadata[toolName]?.discoverable,
      alwaysAvailableExperienceTools.has(toolName),
      `${toolName} discovery posture`,
    );
    if (!alwaysAvailableExperienceTools.has(toolName)) {
      const signal = manifest.toolMetadata[toolName].configSignals?.[0];
      assert.equal(signal?.rootPath, "plugins.entries.clawlore.config", toolName);
      assert.equal(signal?.mode?.path, "agentToolProfile", toolName);
      assert.deepEqual(signal?.mode?.allowed, ["operator", "operator-secret-index"], toolName);
    }
  }

  assert.deepEqual(
    manifest.configContracts.secretInputs.paths.map((entry) => entry.path),
    [
      "embedding.apiKey",
      ...Array.from({ length: 8 }, (_, index) => `embedding.apiKey.${index}`),
      "retrieval.rerankApiKey",
      "llm.apiKey",
    ],
  );
  assert.equal(
    manifest.configSchema.properties.embedding.properties.apiKey.oneOf.find(
      (entry) => entry.type === "array",
    ).maxItems,
    8,
  );
  assert.ok(
    manifest.configContracts.secretInputs.paths.every((entry) => !entry.path.includes("*")),
    "SecretRef array contracts must not fan out across object fields",
  );
  assert.ok(
    manifest.configSchema.properties.embedding.properties.apiKey.oneOf.some(
      (entry) => entry.type === "object",
    ),
  );
  assert.equal(manifest.configSchema.properties.agentToolProfile.default, "memory-write");
  assert.deepEqual(manifest.configSchema.properties.agentToolProfile.enum, [
    "read-only",
    "v2-write",
    "memory-write",
    "self-improvement",
    "operator",
    "operator-secret-index",
  ]);
  assert.deepEqual(
    manifest.configSchema.properties.memoryCompaction.properties.startupMode.enum,
    ["off", "dry-run"],
  );
});

test("Agent memory writes can be removed without disabling read-only recall", () => {
  const tools = new Map();
  registerAllMemoryTools(
    {
      registerTool(factory, meta) {
        tools.set(meta.name, factory({ agentId: "audit-agent" }));
      },
    },
    {
      retriever: { retrieve: async () => [] },
      store: {},
      scopeManager: {},
      embedder: {},
    },
    {
      allowAgentMemoryWriteTools: false,
      enableManagementTools: false,
      enableSelfImprovementTools: false,
      secretIndexToolsEnabled: true,
    },
  );

  assert.equal(tools.has("memory_recall"), true);
  for (const toolName of [
    "memory_store",
    "memory_store_secret_index",
    "memory_forget",
    "memory_update",
  ]) {
    assert.equal(tools.has(toolName), false, toolName);
  }
});

test("legacy plaintext backup and destructive startup compaction are disabled", () => {
  const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /backup timers armed/);
  assert.match(entry, /legacy plaintext autoBackup is disabled/);
  assert.match(entry, /startupMode === "dry-run"/);
  assert.match(entry, /dryRun: true/);
  assert.doesNotMatch(entry, /recordCompactionRun\(compactionStateFile\)/);
  assert.match(entry, /effectiveAgentToolCapabilities\(config\.agentToolProfile,\s*runtimeDiagnostic\.v2WritesEnabled\)/);
});

test("vector repair CLI is dry-run-first and SQLite stores use busy timeout", () => {
  const cli = readClawLoreCliSources();
  assert.match(cli, /\.option\("--apply"/);
  assert.match(cli, /\.option\("--full"/);
  assert.match(cli, /options\.dryRun === true \|\| options\.apply !== true/);
  assert.match(cli, /fullRebuild: options\.full === true/);

  const truthStore = readFileSync(new URL("../src/sql-truth-store.ts", import.meta.url), "utf8");
  const sqliteVectorStore = readFileSync(new URL("../src/sqlite-vector-store.ts", import.meta.url), "utf8");
  assert.match(truthStore, /PRAGMA busy_timeout = 10000/);
  assert.match(sqliteVectorStore, /PRAGMA busy_timeout = 10000/);
});

test("legacy CLI import rejects unsafe rows before retrieval or embedding", () => {
  const source = readFileSync(new URL("../src/cli/experience-commands.ts", import.meta.url), "utf8");
  const safetyGate = source.indexOf("isMemoryEntrySafeForEgress({ text, metadata })");
  const retrieval = source.indexOf("context.retriever.retrieve({", safetyGate);
  const embedding = source.indexOf("context.embedder.embedPassage(text)", safetyGate);

  assert.ok(safetyGate >= 0);
  assert.ok(retrieval > safetyGate);
  assert.ok(embedding > safetyGate);
});

test("legacy CLI export fails closed on unsafe rows and uses private atomic writes", () => {
  const source = readFileSync(new URL("../src/cli/experience-commands.ts", import.meta.url), "utf8");
  const unsafeGate = source.indexOf("isMemoryEntrySafeForEgress(memory)");
  const serialization = source.indexOf("formatJson(exportData)", unsafeGate);
  const privateParent = source.indexOf("verifyPrivatePath(path.dirname(outputPath)", serialization);
  const privateWrite = source.indexOf("writePrivateFileAtomic(outputPath, output)", privateParent);

  assert.ok(unsafeGate >= 0);
  assert.ok(serialization > unsafeGate);
  assert.ok(privateParent > serialization);
  assert.ok(privateWrite > privateParent);
});

test("operator CLI catch paths never print raw error objects", () => {
  const cli = readClawLoreCliSources();
  assert.doesNotMatch(cli, /console\.(?:error|warn)\([^;\n]*,\s*(?:error|err)\s*\)/u);
  assert.doesNotMatch(cli, /console\.(?:error|warn)\(`[^`]*\$\{(?:error|err)\}[^`]*`\)/u);
});

test("operator CLI exposes Yuheng 1.6 governance function surface", () => {
  const cli = readClawLoreCliSources();
  for (const marker of [
    ".command(\"dashboard\")",
    ".command(\"candidates\")",
    ".command(\"governance\")",
    ".command(\"cleanup\")",
    ".command(\"rollback\")",
    ".command(\"audit-coverage\")",
    ".command(\"journal\")",
    ".command(\"recovery\")",
    ".command(\"graph\")",
    ".command(\"hygiene\")",
    ".command(\"forgetting\")",
    ".command(\"experience\")",
    ".command(\"playbooks\")",
    ".command(\"supersede\")",
    ".command(\"authority\")",
    ".command(\"migrate\")",
  ]) {
    assert.ok(cli.includes(marker), marker);
  }

  assert.match(cli, /candidateDebtReport\(db/);
  assert.match(cli, /promoteMemoryCandidates\(db/);
  assert.match(cli, /applyCleanup\(db/);
  assert.match(cli, /rollbackCleanupBatch\(db/);
  assert.match(cli, /recoveryReport\(db/);
  assert.match(cli, /scheduleReplay\(db/);
  assert.match(cli, /graphHygieneReport\(db/);
  assert.match(cli, /repairGraphHygiene\(db/);
  assert.match(cli, /buildForgettingReport\(db/);
  assert.match(cli, /runForgettingWithVectorSync\(db/);
  assert.match(cli, /buildExperienceDebtReport\(db/);
  assert.match(cli, /promoteExperiences\(db/);
  assert.match(cli, /reviewPlaybook\(db/);
  assert.match(cli, /dryRunFromApplyOptions/);
});

test("digest CLI binds SQLite transcript intake to exact identity and dry-run controls", () => {
  const source = readFileSync(
    new URL("../src/cli/governance-commands.ts", import.meta.url),
    "utf8",
  );
  for (const marker of [
    "--transcript-db",
    "--transcript-session-id",
    "--transcript-since-ms",
    "readOpenClawSqliteTranscript",
    "resolvePrincipalWriteTarget",
    "--text, --input-file, and --transcript-db are mutually exclusive",
    "dryRunFromApplyOptions",
  ]) assert.ok(source.includes(marker), marker);
  assert.ok(source.indexOf("readOpenClawSqliteTranscript") < source.indexOf("runDigestPipeline(db"));
  assert.match(source, /sourceType:\s*transcriptSelected[\s\S]{0,160}openclaw_sqlite_transcript/u);
});

test("release gate includes source/live separation and OpenClaw runtime smoke", () => {
  const gate = readFileSync(new URL("../scripts/release-gate.mjs", import.meta.url), "utf8");
  const wrapper = readFileSync(new URL("../scripts/run-release-gate.mjs", import.meta.url), "utf8");
  const operatorContract = readFileSync(new URL("../scripts/release-operator-contract.mjs", import.meta.url), "utf8");
  const preflight = readFileSync(new URL("../scripts/dependency-preflight.mjs", import.meta.url), "utf8");
  const reproducibility = readFileSync(new URL("../scripts/reproducible-install-gate.mjs", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/release-gate.yml", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const buildConfig = JSON.parse(readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8"));
  const gitAttributes = readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");
  const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const vectorRepairSmoke = readFileSync(new URL("../scripts/smoke-vector-repair.mjs", import.meta.url), "utf8");
  const supplyChainAudit = readFileSync(new URL("../scripts/supply-chain-audit.mjs", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["release:gate"], "node scripts/run-release-gate.mjs");
  assert.equal(packageJson.scripts["release:gate:source"], "node scripts/run-release-gate.mjs --source-only");
  assert.equal(packageJson.scripts["release:prepush"], "node scripts/run-release-gate.mjs --pre-push");
  assert.equal(packageJson.engines.node, ">=24.15.0 <25");
  assert.deepEqual(packageJson.os, ["linux", "win32"]);
  assert.equal(packageJson.peerDependencies.openclaw, ">=2026.7.1-beta.5 <2027");
  assert.equal(packageJson.peerDependenciesMeta.openclaw.optional, true);
  assert.equal(packageJson.openclaw.install.minHostVersion, ">=2026.7.1-beta.5");
  assert.equal(packageJson.openclaw.compat.pluginApi, ">=2026.7.1-beta.5");
  assert.equal(packageJson.openclaw.compat.minGatewayVersion, "2026.7.1-beta.5");
  assert.equal(packageJson.clawloreRelease.evidenceFile, "docs/clawlore/eval/clawlore-v1-release-evidence.json");
  assert.match(operatorContract, /CLAWLORE_ALLOW_NESTED_GIT_ROOT/);
  assert.match(operatorContract, /CLAWLORE_SOURCE_ONLY/);
  assert.match(operatorContract, /CLAWLORE_PRE_PUSH/);
  assert.match(operatorContract, /CLAWLORE_RUNTIME_PRINCIPAL/);
  assert.match(operatorContract, /CLAWLORE_RELEASE_REF/);
  assert.match(wrapper, /releaseGateEnvironment/);
  assert.match(wrapper, /shell:\s*false/);
  assert.match(packageJson.scripts["release:reproducibility"], /reproducible-install-gate/);
  assert.match(gate, /"rev-parse",\s*"--show-toplevel"/);
  assert.match(gate, /CLAWLORE_ALLOW_NESTED_GIT_ROOT/);
  assert.match(gate, /packed-lancedb-smoke\.mjs/);
  assert.match(gate, /clawlore-agent-tool-profile-host-smoke\.mjs/);
  assert.equal(packageJson.files.includes("scripts/packed-lancedb-smoke.mjs"), true);
  assert.match(gate, /packed-legacy-identity-smoke\.mjs/);
  assert.equal(packageJson.files.includes("scripts/packed-legacy-identity-smoke.mjs"), true);
  assert.match(gate, /SCOPE_RECALL_ALLOW_NESTED_GIT_ROOT/);
  assert.match(gate, /CLAWLORE_SOURCE_ONLY/);
  assert.match(gate, /SCOPE_RECALL_SOURCE_ONLY/);
  assert.match(gate, /live extension target is missing/);
  assert.match(gate, /runtimeArtifactIdentity/);
  assert.match(gate, /recursive runtime artifact drift/);
  assert.match(gate, /inspect\.plugin\?\.rootDir/);
  assert.match(gate, /package-lock SBOM/);
  assert.match(gate, /"diff",\s*"--check",\s*"--"/);
  assert.match(gate, /refusing self-drift comparison/);
  assert.match(gate, /OPENCLAW_STATE_DIR/);
  assert.match(gate, /OPENCLAW_CONFIG_PATH/);
  assert.match(gate, /plugins",\s*"inspect",\s*"clawlore"/);
  assert.match(gate, /"clawlore",\s*"doctor",\s*"--json",\s*"--quiet"/);
  assert.match(gate, /scripts\/packed-runtime-smoke\.mjs/);
  assert.match(gate, /"npm", \[\s*"install"/);
  assert.match(gate, /function installScannedLocalArchive/);
  assert.match(gate, /\["plugins",\s*"install",\s*"--force",\s*realTarball\]/);
  assert.match(gate, /refusing --force outside the scanned local archive boundary/);
  assert.doesNotMatch(gate, /dangerously-force-unsafe-install/);
  assert.match(gate, /packedRuntimeSmoke: true/);
  assert.match(gate, /installed-tarball OpenClaw inspect/);
  assert.match(gate, /legacy-migrated effective ClawLore config/);
  assert.match(gate, /isDeepSubset\(expectedEffectiveLegacyConfig, effectiveLegacyConfig\)/);
  assert.match(gate, /rawLegacyApiKey\?\.id !== "CLAWLORE_RELEASE_FIXTURE_CREDENTIAL"/);
  assert.match(gate, /effectiveLegacyConfig\.llm\?\.apiKey\?\.id !== "__OPENCLAW_REDACTED__"/);
  assert.match(gate, /migrated legacy identity doctor did not report ok=true/);
  assert.match(gate, /packedOpenClawCliSmoke: true/);
  assert.match(gate, /clawlore\.release-evidence\.v3/);
  assert.match(gate, /NON-AUTHORIZING pre-push mode/);
  assert.match(gate, /publicationVerified: !prePush/);
  assert.match(gate, /packageLockSha256/);
  assert.match(gate, /committedGitBlobSha256/);
  assert.match(gate, /working-tree package-lock\.json bytes differ from the committed Git blob/);
  assert.match(gate, /releaseInputIdentity/);
  assert.match(gate, /checked-in release evidence does not match current release inputs/);
  assert.match(gate, /stableReleaseEvidenceMatches/);
  assert.match(gate, /CLI_SOURCE_PATHS/);
  assert.match(gate, /src\/cli\/auth-config-transaction\.ts/);
  assert.match(gate, /src\/cli\/diagnostic-commands\.ts/);
  assert.match(gate, /src\/cli\/experience-commands\.ts/);
  assert.match(gate, /src\/cli\/governance-commands\.ts/);
  assert.match(gate, /runOpenClawCapture/);
  assert.match(gate, /npm_execpath/);
  assert.match(gate, /process\.execPath/);
  assert.match(preflight, /npm_execpath/);
  assert.match(preflight, /process\.execPath/);
  assert.match(reproducibility, /npm_execpath/);
  assert.match(reproducibility, /process\.execPath/);
  assert.match(supplyChainAudit, /npm_execpath/);
  assert.match(supplyChainAudit, /process\.execPath/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /openclaw@2026\.7\.1-beta\.5/);
  assert.match(workflow, /npm run release:prepush/);
  assert.equal(buildConfig.compilerOptions.newLine, "lf");
  assert.match(gitAttributes, /^\/package\.json text eol=lf$/m);
  assert.match(gitAttributes, /^\/package-lock\.json text eol=lf$/m);
  assert.match(gitAttributes, /^\/openclaw\.plugin\.json text eol=lf$/m);
  assert.match(gitAttributes, /^\/src\/\*\*\/\*\.ts text eol=lf$/m);
  assert.match(gitAttributes, /^\/dist\/\*\.js text eol=lf$/m);
  assert.match(gitAttributes, /^\/dist\/\*\*\/\*\.js text eol=lf$/m);
  assert.match(vectorRepairSmoke, /await store\?\.close\(\)/);
  assert.ok(
    vectorRepairSmoke.indexOf("await store?.close()") < vectorRepairSmoke.indexOf("await rm(dbPath"),
    "vector repair smoke must close SQLite before removing its temporary directory",
  );
  assert.equal(
    packageJson.clawloreRelease.scriptPolicy,
    "all-except-published-runtime-scripts-are-source-checkout-only",
  );
  assert.deepEqual(packageJson.clawloreRelease.publishedRuntimeScripts, [
    "smoke:packed-runtime",
    "smoke:packed-fresh-v2",
  ]);
  assert.equal(packageJson.scripts["smoke:packed-runtime"], "node scripts/packed-runtime-smoke.mjs");
  assert.equal(packageJson.scripts["smoke:packed-fresh-v2"], "node scripts/packed-fresh-v2-smoke.mjs");
  assert.ok(packageJson.files.includes("scripts/packed-runtime-smoke.mjs"));
  assert.ok(packageJson.files.includes("scripts/packed-fresh-v2-smoke.mjs"));
  assert.match(indexSource, /diagnosticBuildTag = `\$\{DIAG_BUILD_TAG_PREFIX\}-\$\{pluginVersion\}`/);
  assert.doesNotMatch(indexSource, /scope-recall-openclaw-1\.0\.24/);
});

test("canonical release evidence compares stable SBOM metadata and only permits declared variance", () => {
  const evidence = JSON.parse(readFileSync(
    new URL("../docs/clawlore/eval/clawlore-v1-release-evidence.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(evidence.allowedPlatformVariance, ALLOWED_PLATFORM_VARIANCE);

  const allowed = structuredClone(evidence);
  allowed.observedCommit = "platform-specific-observation";
  allowed.sbom.componentCount += 1;
  allowed.sbom.sha256 = "platform-specific-sbom-digest";
  allowed.sbom.toolVersion = "platform-specific-npm";
  allowed.toolchain = {
    node: "platform-node",
    npm: "platform-npm",
    os: "platform-os",
    arch: "platform-arch",
  };
  assert.equal(stableReleaseEvidenceMatches(evidence, allowed), true);

  for (const [field, value] of [
    ["format", "NotCycloneDX"],
    ["specVersion", "0.0"],
    ["tool", "untrusted sbom tool"],
  ]) {
    const changed = structuredClone(allowed);
    changed.sbom[field] = value;
    assert.equal(stableReleaseEvidenceMatches(evidence, changed), false, field);
  }
});

test("CLI metadata registration defers secret and database materialization until command execution", () => {
  const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../src/core-memory-runtime.ts", import.meta.url), "utf8");
  const registerStart = entry.indexOf("register(api: OpenClawPluginApi)");
  const metadataBranch = entry.indexOf("if (isCliRegistrationMode(api))", registerStart);
  const runtimeParse = entry.indexOf("const config = parseRuntimePluginConfig(api.pluginConfig)", registerStart);

  assert.ok(registerStart >= 0);
  assert.ok(metadataBranch > registerStart);
  assert.ok(runtimeParse > metadataBranch);
  assert.match(runtime, /resolveSecretRefValues/);
  assert.match(runtime, /applyResolvedAssignments/);
  const configParser = readFileSync(new URL("../src/plugin-config.ts", import.meta.url), "utf8");
  assert.match(configParser, /OpenClaw did not resolve manifest-declared runtime SecretRefs/);
  assert.match(entry, /registerCliMetadata\(api\)/);
  assert.match(cli, /hook\("preAction"/);
  assert.match(cli, /await context\.beforeAction\?\.\(path\)/);
});
