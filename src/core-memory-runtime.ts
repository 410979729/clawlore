import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { isSecretRef } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig, SecretRef } from "openclaw/plugin-sdk/config-types";
import {
  applyResolvedAssignments,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/runtime-secret-resolution";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { applyClawteamScopes, parseClawteamScopes } from "./clawteam-scope.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "./decay-engine.js";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { createEmbedder, getVectorDimensions } from "./embedder.js";
import { createLlmClient } from "./llm-client.js";
import { createMigrator } from "./migrate.js";
import {
  assignOpenAiClientCredential,
  parsePluginConfig,
  resolveConfigString,
  resolveFirstApiKey,
  resolveLlmTimeoutMs,
  type PluginConfig,
} from "./plugin-config.js";
import {
  CLAWLORE_LEGACY_DEFAULTS,
  CLAWLORE_PLUGIN_ID,
} from "./product-identity.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
import { createScopeManager } from "./scopes.js";
import { MemoryStore, validateStoragePath } from "./store.js";
import { createTierManager, DEFAULT_TIER_CONFIG } from "./tier-manager.js";

export type CoreMemoryRuntime = {
  config: PluginConfig;
  resolvedDbPath: string;
  embeddingModel: string;
  store: MemoryStore;
  embedder: ReturnType<typeof createEmbedder>;
  decayEngine: ReturnType<typeof createDecayEngine>;
  tierManager: ReturnType<typeof createTierManager>;
  retriever: ReturnType<typeof createRetriever>;
  scopeManager: ReturnType<typeof createScopeManager>;
  migrator: ReturnType<typeof createMigrator>;
  cliLlmClient: ReturnType<typeof createLlmClient> | undefined;
};

export type ConfiguredLlmRuntime = {
  client: ReturnType<typeof createLlmClient>;
  model: string;
  timeoutMs: number;
};

function getDefaultDbPath(): string {
  const memoryRoot = join(homedir(), ".openclaw", "memory");
  const canonical = join(memoryRoot, CLAWLORE_PLUGIN_ID);
  const legacy = join(memoryRoot, CLAWLORE_LEGACY_DEFAULTS.dataDirectoryName);
  return !existsSync(canonical) && existsSync(legacy) ? legacy : canonical;
}

export function getDefaultWorkspaceDir(): string {
  return join(homedir(), ".openclaw", "workspace");
}

function resolveOptionalPathWithEnv(
  api: Pick<OpenClawPluginApi, "resolvePath">,
  value: string | undefined,
  fallback: string,
): string {
  const raw = typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  return api.resolvePath(resolveConfigString(raw));
}

function resolveDefaultOauthPathWithCompatibility(
  api: Pick<OpenClawPluginApi, "resolvePath">,
): string {
  const canonical = api.resolvePath(".clawlore/oauth.json");
  const legacy = api.resolvePath(`${CLAWLORE_LEGACY_DEFAULTS.oauthDirectoryName}/oauth.json`);
  return !existsSync(canonical) && existsSync(legacy) ? legacy : canonical;
}

/** Builds one configured LLM client for CLI or runtime extraction composition. */
export function createConfiguredLlmRuntime(
  api: Pick<OpenClawPluginApi, "resolvePath" | "logger">,
  config: PluginConfig,
): ConfiguredLlmRuntime {
  const llmAuth = config.llm?.auth || "api-key";
  const llmApiKey = llmAuth === "oauth"
    ? undefined
    : config.llm?.apiKey
      ? resolveConfigString(config.llm.apiKey)
      : config.embedding.apiKey
        ? resolveFirstApiKey(config.embedding.apiKey)
        : undefined;
  const llmBaseURL = llmAuth === "oauth"
    ? (config.llm?.baseURL ? resolveConfigString(config.llm.baseURL) : undefined)
    : config.llm?.baseURL
      ? resolveConfigString(config.llm.baseURL)
      : config.embedding.baseURL;
  const model = config.llm?.model || "openai/gpt-oss-120b";
  const oauthPath = llmAuth === "oauth"
    ? config.llm?.oauthPath
      ? resolveOptionalPathWithEnv(api, config.llm.oauthPath, ".clawlore/oauth.json")
      : resolveDefaultOauthPathWithCompatibility(api)
    : undefined;
  const timeoutMs = resolveLlmTimeoutMs(config);
  const clientConfig = {
    auth: llmAuth,
    model,
    baseURL: llmBaseURL,
    oauthProvider: llmAuth === "oauth" ? config.llm?.oauthProvider : undefined,
    oauthPath,
    timeoutMs,
    log: (message: string) => api.logger.debug(message),
  } as Parameters<typeof createLlmClient>[0];
  return {
    client: createLlmClient(assignOpenAiClientCredential(clientConfig, llmApiKey)),
    model,
    timeoutMs,
  };
}

/** Constructs the concrete memory runtime; it does not register host hooks or tools. */
export function createCoreMemoryRuntime(
  api: OpenClawPluginApi,
  config: PluginConfig,
): CoreMemoryRuntime {
  const configuredDbPath = config.dbPath || getDefaultDbPath();
  const hostResolvedDbPath = api.resolvePath(configuredDbPath);
  const resolvedDbPath = typeof hostResolvedDbPath === "string" && hostResolvedDbPath.trim().length > 0
    ? hostResolvedDbPath
    : configuredDbPath;

  try {
    validateStoragePath(resolvedDbPath);
  } catch (error) {
    api.logger.warn(
      `clawlore: storage path issue — ${diagnosticErrorSummary(error)}\n`
      + "  The plugin will still attempt to start, but writes may fail.",
    );
  }

  const defaultEmbeddingModel = config.embedding.provider === "local-debug"
    ? "debug-hash-v1"
    : config.embedding.provider === "local-hash"
      ? "hash-v1"
      : config.embedding.provider === "minimax"
        ? "embo-01"
        : "text-embedding-3-small";
  const embeddingModel = config.embedding.model || defaultEmbeddingModel;
  const vectorDim = getVectorDimensions(embeddingModel, config.embedding.dimensions);
  const store = new MemoryStore({
    dbPath: resolvedDbPath,
    vectorDim,
    vectorBackend: config.vectorBackend,
  });
  const embedderConfig = {
    provider: config.embedding.provider,
    model: embeddingModel,
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
    groupId: config.embedding.groupId,
    omitDimensions: config.embedding.omitDimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
    normalized: config.embedding.normalized,
    chunking: config.embedding.chunking,
  } as Parameters<typeof createEmbedder>[0];
  const embedder = createEmbedder(
    assignOpenAiClientCredential(embedderConfig, config.embedding.apiKey),
  );
  const decayEngine = createDecayEngine({ ...DEFAULT_DECAY_CONFIG, ...(config.decay || {}) });
  const tierManager = createTierManager({ ...DEFAULT_TIER_CONFIG, ...(config.tier || {}) });
  const retriever = createRetriever(
    store,
    embedder,
    { ...DEFAULT_RETRIEVAL_CONFIG, ...config.retrieval },
    { decayEngine },
  );
  const scopeManager = createScopeManager(config.scopes);
  const clawteamScopes = parseClawteamScopes(process.env.CLAWTEAM_MEMORY_SCOPE);
  if (clawteamScopes.length > 0) {
    applyClawteamScopes(scopeManager, clawteamScopes);
    api.logger.info(`clawlore: CLAWTEAM_MEMORY_SCOPE added scopes: ${clawteamScopes.join(", ")}`);
  }

  const migrator = createMigrator(store);
  const cliLlmClient = (() => {
    try {
      return createConfiguredLlmRuntime(api, config).client;
    } catch {
      return undefined;
    }
  })();

  return {
    config,
    resolvedDbPath,
    embeddingModel,
    store,
    embedder,
    decayEngine,
    tierManager,
    retriever,
    scopeManager,
    migrator,
    cliLlmClient,
  };
}

/** Resolves SecretRefs before parsing CLI config; metadata-only registration stays side-effect free. */
export async function resolveCliPluginConfig(api: OpenClawPluginApi): Promise<PluginConfig> {
  const sourceConfig = structuredClone((api.config ?? {}) as OpenClawConfig);
  const pluginConfig = structuredClone((api.pluginConfig ?? {}) as Record<string, unknown>);
  const assignments: Array<{
    ref: SecretRef;
    path: string;
    expected: "string";
    apply: (value: unknown) => void;
  }> = [];
  const addAssignment = (value: unknown, path: string, apply: (value: unknown) => void) => {
    const ref = isSecretRef(value) ? value as SecretRef : null;
    if (ref) assignments.push({ ref, path, expected: "string", apply });
  };

  const embedding = pluginConfig.embedding as Record<string, unknown> | undefined;
  if (embedding) {
    if (Array.isArray(embedding.apiKey)) {
      embedding.apiKey.forEach((value, index) => {
        addAssignment(value, `embedding.apiKey.${index}`, (resolved) => {
          (embedding.apiKey as unknown[])[index] = resolved;
        });
      });
    } else {
      addAssignment(embedding.apiKey, "embedding.apiKey", (resolved) => {
        embedding.apiKey = resolved;
      });
    }
  }
  const retrieval = pluginConfig.retrieval as Record<string, unknown> | undefined;
  if (retrieval) {
    addAssignment(retrieval.rerankApiKey, "retrieval.rerankApiKey", (resolved) => {
      retrieval.rerankApiKey = resolved;
    });
  }
  const llm = pluginConfig.llm as Record<string, unknown> | undefined;
  if (llm) {
    addAssignment(llm.apiKey, "llm.apiKey", (resolved) => {
      llm.apiKey = resolved;
    });
  }

  if (assignments.length > 0) {
    const resolvedValues = await resolveSecretRefValues(
      assignments.map((assignment) => assignment.ref),
      { config: sourceConfig, env: process.env },
    );
    applyResolvedAssignments({ assignments, resolved: resolvedValues });
  }
  return parsePluginConfig(pluginConfig);
}
