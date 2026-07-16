import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

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
const { resolveRuntimeMemoryAccess } = jiti("../src/runtime-memory-boundary.ts");

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
      vectorSearch: async () => [],
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
    embedder: { embedPassage: async () => [0.1, 0.2, 0.3] },
    workspaceDir: "/workspace/default",
    principalIsolation: options.principalIsolation,
  };
  registerAllMemoryTools(api, context, {
    enableManagementTools: true,
    enableSelfImprovementTools: false,
    secretIndexToolsEnabled: options.secretIndexToolsEnabled === true,
  });
  return { tools, stored, retrieved };
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
  assert.equal(metadata.workspace_dir, "/workspace/runtime");
  assert.equal(metadata.scope_id, expectedScope);
  assert.deepEqual(metadata.scope_filter, [expectedScope]);
  assert.equal(metadata.scope_filter_mode, "restricted");
  assert.equal(metadata.memory_boundary, "private");
  assert.equal(metadata.principal_hash.length, 16);
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
    embed: async () => [0.4, 0.5, 0.6],
  };
  const llm = {
    async completeJson(_prompt, label) {
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
    "Joy said OpenClaw release audits should include targeted regression tests.",
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

  const secretSignal = manifest.toolMetadata.memory_store_secret_index.configSignals[0];
  assert.equal(secretSignal.rootPath, "plugins.entries.clawlore.config");
  assert.equal(secretSignal.mode.path, "secretIndexToolsEnabled");
  assert.deepEqual(secretSignal.mode.allowed, ["true"]);

  const governSignal = manifest.toolMetadata.memory_govern.configSignals[0];
  assert.equal(governSignal.rootPath, "plugins.entries.clawlore.config");
  assert.equal(governSignal.mode.path, "enableManagementTools");
  assert.deepEqual(governSignal.mode.allowed, ["true"]);

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
      assert.equal(signal?.mode?.path, "enableManagementTools", toolName);
      assert.deepEqual(signal?.mode?.allowed, ["true"], toolName);
    }
  }

  assert.deepEqual(
    manifest.configContracts.secretInputs.paths.map((entry) => entry.path),
    ["embedding.apiKey", "embedding.apiKey.*", "retrieval.rerankApiKey", "llm.apiKey"],
  );
  assert.ok(
    manifest.configSchema.properties.embedding.properties.apiKey.oneOf.some(
      (entry) => entry.type === "object",
    ),
  );
  assert.equal(
    manifest.configSchema.properties.allowAgentOperatorTools.default,
    false,
  );
  assert.deepEqual(
    manifest.configSchema.properties.memoryCompaction.properties.startupMode.enum,
    ["off", "dry-run"],
  );
});

test("legacy plaintext backup and destructive startup compaction are disabled", () => {
  const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /backup timers armed/);
  assert.match(entry, /legacy plaintext autoBackup is disabled/);
  assert.match(entry, /startupMode === "dry-run"/);
  assert.match(entry, /dryRun: true/);
  assert.doesNotMatch(entry, /recordCompactionRun\(compactionStateFile\)/);
  assert.match(entry, /config\.allowAgentOperatorTools === true/);
});

test("vector repair CLI is dry-run-first and SQLite stores use busy timeout", () => {
  const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
  assert.match(cli, /\.option\("--apply"/);
  assert.match(cli, /\.option\("--full"/);
  assert.match(cli, /options\.dryRun === true \|\| options\.apply !== true/);
  assert.match(cli, /fullRebuild: options\.full === true/);

  const truthStore = readFileSync(new URL("../src/sql-truth-store.ts", import.meta.url), "utf8");
  const sqliteVectorStore = readFileSync(new URL("../src/sqlite-vector-store.ts", import.meta.url), "utf8");
  assert.match(truthStore, /PRAGMA busy_timeout = 10000/);
  assert.match(sqliteVectorStore, /PRAGMA busy_timeout = 10000/);
});

test("operator CLI exposes Yuheng 1.6 governance function surface", () => {
  const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
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

test("release gate includes source/live separation and OpenClaw runtime smoke", () => {
  const gate = readFileSync(new URL("../scripts/release-gate.mjs", import.meta.url), "utf8");
  const wrapper = readFileSync(new URL("../scripts/run-release-gate.mjs", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/release-gate.yml", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["release:gate"], "node scripts/run-release-gate.mjs");
  assert.equal(packageJson.scripts["release:gate:source"], "node scripts/run-release-gate.mjs --source-only");
  assert.equal(packageJson.engines.node, ">=24.0.0 <25");
  assert.deepEqual(packageJson.os, ["linux", "win32"]);
  assert.equal(packageJson.peerDependencies.openclaw, ">=2026.7.1-beta.2 <2027");
  assert.equal(packageJson.peerDependenciesMeta.openclaw.optional, true);
  assert.equal(packageJson.clawloreRelease.evidenceFile, "docs/clawlore/eval/clawlore-v1-release-evidence.json");
  assert.match(wrapper, /CLAWLORE_ALLOW_NESTED_GIT_ROOT/);
  assert.match(wrapper, /CLAWLORE_SOURCE_ONLY/);
  assert.match(wrapper, /shell:\s*false/);
  assert.match(packageJson.scripts["release:reproducibility"], /reproducible-install-gate/);
  assert.match(gate, /"rev-parse",\s*"--show-toplevel"/);
  assert.match(gate, /CLAWLORE_ALLOW_NESTED_GIT_ROOT/);
  assert.match(gate, /packed-lancedb-smoke\.mjs/);
  assert.equal(packageJson.files.includes("scripts/packed-lancedb-smoke.mjs"), true);
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
  assert.match(gate, /packedRuntimeSmoke: true/);
  assert.match(gate, /installed-tarball OpenClaw inspect/);
  assert.match(gate, /packedOpenClawCliSmoke: true/);
  assert.match(gate, /clawlore\.release-evidence\.v2/);
  assert.match(gate, /packageLockSha256/);
  assert.match(gate, /releaseInputIdentity/);
  assert.match(gate, /checked-in release evidence does not match current release inputs/);
  assert.match(gate, /runOpenClawCapture/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /npm run release:gate:source/);
  assert.equal(
    packageJson.clawloreRelease.scriptPolicy,
    "all-except-published-runtime-scripts-are-source-checkout-only",
  );
  assert.deepEqual(packageJson.clawloreRelease.publishedRuntimeScripts, ["smoke:packed-runtime"]);
  assert.equal(packageJson.scripts["smoke:packed-runtime"], "node scripts/packed-runtime-smoke.mjs");
  assert.ok(packageJson.files.includes("scripts/packed-runtime-smoke.mjs"));
  assert.match(indexSource, /diagnosticBuildTag = `\$\{DIAG_BUILD_TAG_PREFIX\}-\$\{pluginVersion\}`/);
  assert.doesNotMatch(indexSource, /scope-recall-openclaw-1\.0\.24/);
});

test("CLI metadata registration defers secret and database materialization until command execution", () => {
  const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
  const registerStart = entry.indexOf("register(api: OpenClawPluginApi)");
  const metadataBranch = entry.indexOf("if (isCliRegistrationMode(api))", registerStart);
  const runtimeParse = entry.indexOf("const config = parsePluginConfig(api.pluginConfig)", registerStart);

  assert.ok(registerStart >= 0);
  assert.ok(metadataBranch > registerStart);
  assert.ok(runtimeParse > metadataBranch);
  assert.match(entry, /resolveSecretRefValues/);
  assert.match(entry, /applyResolvedAssignments/);
  assert.match(entry, /registerCliMetadata\(api\)/);
  assert.match(cli, /hook\("preAction"/);
  assert.match(cli, /await context\.beforeAction\?\.\(path\)/);
});
