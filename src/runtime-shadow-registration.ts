import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { join } from "node:path";

import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import type { PluginConfig } from "./plugin-config.js";
import { canonicalDigest, computeRuntimeReleaseBinding, resolvePluginRoot } from "./release-provenance.js";
import type { createRetriever } from "./retriever.js";
import {
  buildRuntimeDiagnosticReceipt,
  createRuntimeInstanceIdentity,
  invalidateRuntimeDiagnosticReceipt,
  renewRuntimeDiagnosticReceipt,
  resolveRuntimeDiagnosticFile,
  RUNTIME_DIAGNOSTIC_HEARTBEAT_MS,
  writeRuntimeDiagnosticReceipt,
  type RuntimeDiagnosticReceiptV2,
} from "./runtime-diagnostic-receipt.js";
import { resolveScopeFilter } from "./scopes.js";
import type { createScopeManager } from "./scopes.js";
import {
  createLegacyShadowCandidateRetrieverV1,
} from "./adapters/openclaw/legacy-shadow-retrieval.js";
import {
  createNativeShadowCandidateRetrieverV1,
} from "./adapters/openclaw/native-shadow-retrieval.js";
import { createClawLoreNativeContextEngineV1 } from "./adapters/openclaw/native-context-engine.js";
import {
  composeClawLoreRuntimeV1,
  normalizeClawLoreRuntimeConfigV1,
} from "./adapters/openclaw/runtime-composition-root.js";
import { loadRuntimeRolloutControlsV1 } from "./adapters/openclaw/runtime-rollout-control.js";
import { filterUserMdExclusiveRecallResults } from "./workspace-boundary.js";
import { runtimeTransitionPolicyBlocksV1 } from "./application/runtime-transition-policy.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRuntimeDiagnosticLeaseController(params: {
  file: string;
  baseReceipt: RuntimeDiagnosticReceiptV2;
  logger: { warn(message: string): void };
}): {
  persist(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  let currentReceipt = params.baseReceipt;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let writeChain = Promise.resolve();
  let generation = 0;
  const queueWrite = (nextReceipt: RuntimeDiagnosticReceiptV2): Promise<void> => {
    currentReceipt = nextReceipt;
    writeChain = writeChain
      .catch(() => undefined)
      .then(() => writeRuntimeDiagnosticReceipt(params.file, nextReceipt));
    return writeChain;
  };
  const persist = () => queueWrite(renewRuntimeDiagnosticReceipt(currentReceipt));
  return {
    persist,
    async start() {
      generation++;
      const activeGeneration = generation;
      if (heartbeat) clearInterval(heartbeat);
      await queueWrite(renewRuntimeDiagnosticReceipt(params.baseReceipt));
      heartbeat = setInterval(() => {
        if (activeGeneration !== generation) return;
        void persist().catch((error) => {
          params.logger.warn(`clawlore: runtime diagnostic heartbeat failed: ${diagnosticErrorSummary(error)}`);
        });
      }, RUNTIME_DIAGNOSTIC_HEARTBEAT_MS);
      heartbeat.unref?.();
    },
    async stop() {
      generation++;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      try {
        await queueWrite(invalidateRuntimeDiagnosticReceipt(currentReceipt));
      } catch (error) {
        params.logger.warn(`clawlore: runtime diagnostic invalidation failed: ${diagnosticErrorSummary(error)}`);
      }
    },
  };
}

/** Registers the receipt-gated ClawLore runtime. Shadow remains strictly read-only. */
export function registerClawLoreShadowRuntime(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  resolvedDbPath: string;
  retriever: ReturnType<typeof createRetriever>;
  scopeManager: ReturnType<typeof createScopeManager>;
  pluginEntryUrl: string;
}): {
  file: string;
  v2WritesEnabled: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  persist(): Promise<void>;
} {
  const { api, config, resolvedDbPath, retriever, scopeManager } = params;
  const retrieveWithRetry = async (input: {
    query: string;
    limit: number;
    scopeFilter?: string[];
    category?: string;
    source?: "manual" | "auto-recall" | "cli";
    signal?: AbortSignal;
  }) => {
    let results = await retriever.retrieve(input);
    if (results.length === 0) {
      if (input.signal?.aborted) throw new Error("retrieval aborted");
      await sleep(75);
      if (input.signal?.aborted) throw new Error("retrieval aborted");
      results = await retriever.retrieve(input);
    }
    return results;
  };

  const runtimeConfig = normalizeClawLoreRuntimeConfigV1(config.runtime);
  let releaseBinding: ReturnType<typeof computeRuntimeReleaseBinding> | undefined;
  const bindingErrors: string[] = [];
  if (runtimeConfig.mode !== "disabled") {
    try {
      releaseBinding = computeRuntimeReleaseBinding({
        pluginRoot: resolvePluginRoot(params.pluginEntryUrl),
        config,
        sqlitePath: join(resolvedDbPath, "memory.sqlite3"),
      });
    } catch (error) {
      bindingErrors.push(`release_runtime_binding_failed:${diagnosticErrorSummary(error)}`);
    }
  }
  const rolloutControls = runtimeConfig.mode !== "disabled" && releaseBinding
    ? loadRuntimeRolloutControlsV1({
        readinessFile: config.runtime?.readinessFile
          ? api.resolvePath(config.runtime.readinessFile)
          : undefined,
        expectedBinding: releaseBinding,
        expectedMode: runtimeConfig.mode,
      })
    : { readiness: undefined, errors: bindingErrors };
  if (rolloutControls.errors.length > 0) {
    api.logger.warn(`clawlore: shadow rollout controls blocked: ${rolloutControls.errors.join(",")}`);
  }

  const legacyRetriever = createLegacyShadowCandidateRetrieverV1({
    workspaceId: "tianji-main-workspace",
    candidateLimit: runtimeConfig.candidateLimit,
    resolveScopeFilter: (agentId) => resolveScopeFilter(scopeManager, agentId),
    retrieve: async (input) => filterUserMdExclusiveRecallResults(
      await retrieveWithRetry(input),
      config.workspaceBoundary,
    ),
  });
  const legacyCache = new WeakMap<object, ReturnType<typeof legacyRetriever>>();
  const cachedLegacyRetriever = (request: Parameters<typeof legacyRetriever>[0]) => {
    const cached = legacyCache.get(request);
    if (cached) return cached;
    const pending = legacyRetriever(request);
    legacyCache.set(request, pending);
    return pending;
  };
  const nativeRetriever = createNativeShadowCandidateRetrieverV1({
    sqlitePath: join(resolvedDbPath, "memory.sqlite3"),
    candidateLimit: runtimeConfig.candidateLimit,
    async retrieveVectorCandidates({ request }) {
      if (request.signal?.aborted) throw new Error("shadow retrieval aborted");
      const candidates = await cachedLegacyRetriever(request);
      if (request.signal?.aborted) throw new Error("shadow retrieval aborted");
      return candidates.map((candidate) => ({
        legacyId: candidate.id.startsWith("legacy:")
          ? candidate.id.slice("legacy:".length)
          : candidate.id,
        score: candidate.score,
      }));
    },
  });

  const nativeBlocks: string[] = [];
  nativeBlocks.push(...runtimeTransitionPolicyBlocksV1({
    mode: runtimeConfig.mode,
    contextEngine: runtimeConfig.contextEngine,
    agentToolProfile: config.agentToolProfile,
    autoCapture: config.autoCapture === true,
    smartExtraction: config.smartExtraction === true,
    sessionStrategy: config.sessionStrategy ?? "none",
  }));
  if (runtimeConfig.mode === "cutover") {
    if (!rolloutControls.readiness || rolloutControls.readiness.status !== "ready" || !rolloutControls.readiness.rollout.ready) {
      nativeBlocks.push("release_readiness_blocked");
    }
    nativeBlocks.push(...rolloutControls.errors);
  } else if (runtimeConfig.mode === "v2-write") {
    if (!rolloutControls.readiness || rolloutControls.readiness.status !== "ready" || !rolloutControls.readiness.rollout.ready) {
      nativeBlocks.push("release_readiness_blocked");
    }
    nativeBlocks.push(...rolloutControls.errors);
  }
  const receipt = runtimeConfig.mode === "cutover"
    ? (() => {
        if (nativeBlocks.length === 0) {
          api.registerContextEngine("clawlore", () => createClawLoreNativeContextEngineV1({
            version: String((rolloutControls.readiness?.provenance.sourceCommit ?? "unknown").slice(0, 12)),
            tenantId: "local",
            agentId: "main",
            workspaceId: "tianji-main-workspace",
            tokenBudget: runtimeConfig.tokenBudget,
            maxQueryChars: runtimeConfig.maxQueryChars,
            retrieveCandidates: nativeRetriever,
          }) as any);
        }
        return {
          schemaVersion: 1 as const,
          status: nativeBlocks.length === 0 ? "registered" as const : "blocked" as const,
          requestedMode: runtimeConfig.mode,
          registeredHooks: [],
          toolRegistrations: 0 as const,
          writeEnabled: nativeBlocks.length === 0,
          promptMutationEnabled: nativeBlocks.length === 0,
          contextEngineRegistered: nativeBlocks.length === 0,
          contextEngine: {
            selected: "native-opt-in" as const,
            canActivateNative: nativeBlocks.length === 0,
            missingCapabilities: [],
            reason: nativeBlocks.length === 0
              ? "native_context_engine_registered"
              : "native_context_engine_blocked",
          },
          blockingReasons: [...new Set(nativeBlocks)].sort(),
        };
      })()
    : runtimeConfig.mode === "v2-write"
      ? {
          schemaVersion: 1 as const,
          status: nativeBlocks.length === 0 ? "registered" as const : "blocked" as const,
          requestedMode: runtimeConfig.mode,
          registeredHooks: [],
          toolRegistrations: 0 as const,
          writeEnabled: nativeBlocks.length === 0,
          promptMutationEnabled: false as const,
          contextEngineRegistered: false as const,
          contextEngine: {
            selected: "compatibility" as const,
            canActivateNative: false,
            missingCapabilities: [],
            reason: "v2_write_uses_compatibility_recall",
          },
          blockingReasons: [...new Set(nativeBlocks)].sort(),
        }
      : composeClawLoreRuntimeV1({
        config: runtimeConfig,
        host: {
          on(event, handler, options) {
            api.on(event, handler as any, options);
          },
        },
        dependencies: {
          tenantId: "local",
          agentId: "main",
          workspaceId: "tianji-main-workspace",
          retrieveCandidates: nativeRetriever,
          retrieveComparisonCandidates: cachedLegacyRetriever,
          onObserverError(code) {
            api.logger.warn(`clawlore: read-only shadow observer ${code}`);
          },
          onObserverMetrics(metrics) {
            api.logger.debug?.(
              `clawlore: observer metrics active=${metrics.active} late=${metrics.late} timeouts=${metrics.timeouts} saturated=${metrics.saturated}`,
            );
          },
        },
        readiness: rolloutControls.readiness,
      });
  api.logger.info(
    `clawlore: runtime status=${receipt.status} mode=${receipt.requestedMode} hooks=${receipt.registeredHooks.length} writes=${receipt.writeEnabled} promptMutation=${receipt.promptMutationEnabled} contextEngine=${receipt.contextEngineRegistered} blocks=${receipt.blockingReasons.join(",") || "none"}`,
  );
  const instance = createRuntimeInstanceIdentity();
  const diagnosticReceipt = buildRuntimeDiagnosticReceipt({
    configDigest: canonicalDigest(config),
    binding: releaseBinding,
    readiness: rolloutControls.readiness,
    readinessErrors: rolloutControls.errors,
    runtime: receipt,
    instance,
  });
  const file = resolveRuntimeDiagnosticFile(resolvedDbPath);
  return {
    file,
    v2WritesEnabled: receipt.status === "registered"
      && (receipt.requestedMode === "v2-write" || receipt.requestedMode === "cutover"),
    ...createRuntimeDiagnosticLeaseController({
      file,
      baseReceipt: diagnosticReceipt,
      logger: api.logger,
    }),
  };
}
