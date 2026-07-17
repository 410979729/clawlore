import { join } from "node:path";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { computeRuntimeReleaseBinding, resolvePluginRoot } from "./release-provenance.js";
import { resolveScopeFilter } from "./scopes.js";
import { createLegacyShadowCandidateRetrieverV1, } from "./adapters/openclaw/legacy-shadow-retrieval.js";
import { createNativeShadowCandidateRetrieverV1, } from "./adapters/openclaw/native-shadow-retrieval.js";
import { composeClawLoreRuntimeV1, normalizeClawLoreRuntimeConfigV1, } from "./adapters/openclaw/runtime-composition-root.js";
import { loadRuntimeRolloutControlsV1 } from "./adapters/openclaw/runtime-rollout-control.js";
import { filterUserMdExclusiveRecallResults } from "./workspace-boundary.js";
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
/** Registers the read-only ClawLore shadow runtime; it never enables writes or prompt mutation. */
export function registerClawLoreShadowRuntime(params) {
    const { api, config, resolvedDbPath, retriever, scopeManager } = params;
    const retrieveWithRetry = async (input) => {
        let results = await retriever.retrieve(input);
        if (results.length === 0) {
            if (input.signal?.aborted)
                throw new Error("retrieval aborted");
            await sleep(75);
            if (input.signal?.aborted)
                throw new Error("retrieval aborted");
            results = await retriever.retrieve(input);
        }
        return results;
    };
    const runtimeConfig = normalizeClawLoreRuntimeConfigV1(config.runtime);
    let releaseBinding;
    const bindingErrors = [];
    if (runtimeConfig.mode === "shadow") {
        try {
            releaseBinding = computeRuntimeReleaseBinding({
                pluginRoot: resolvePluginRoot(params.pluginEntryUrl),
                config,
                sqlitePath: join(resolvedDbPath, "memory.sqlite3"),
            });
        }
        catch (error) {
            bindingErrors.push(`release_runtime_binding_failed:${diagnosticErrorSummary(error)}`);
        }
    }
    const rolloutControls = runtimeConfig.mode === "shadow" && releaseBinding
        ? loadRuntimeRolloutControlsV1({
            readinessFile: config.runtime?.readinessFile
                ? api.resolvePath(config.runtime.readinessFile)
                : undefined,
            expectedBinding: releaseBinding,
        })
        : { readiness: undefined, errors: bindingErrors };
    if (rolloutControls.errors.length > 0) {
        api.logger.warn(`clawlore: shadow rollout controls blocked: ${rolloutControls.errors.join(",")}`);
    }
    const legacyRetriever = createLegacyShadowCandidateRetrieverV1({
        workspaceId: "tianji-main-workspace",
        candidateLimit: runtimeConfig.candidateLimit,
        resolveScopeFilter: (agentId) => resolveScopeFilter(scopeManager, agentId),
        retrieve: async (input) => filterUserMdExclusiveRecallResults(await retrieveWithRetry(input), config.workspaceBoundary),
    });
    const legacyCache = new WeakMap();
    const cachedLegacyRetriever = (request) => {
        const cached = legacyCache.get(request);
        if (cached)
            return cached;
        const pending = legacyRetriever(request);
        legacyCache.set(request, pending);
        return pending;
    };
    const nativeRetriever = createNativeShadowCandidateRetrieverV1({
        sqlitePath: join(resolvedDbPath, "memory.sqlite3"),
        candidateLimit: runtimeConfig.candidateLimit,
        async retrieveVectorCandidates({ request }) {
            if (request.signal?.aborted)
                throw new Error("shadow retrieval aborted");
            const candidates = await cachedLegacyRetriever(request);
            if (request.signal?.aborted)
                throw new Error("shadow retrieval aborted");
            return candidates.map((candidate) => ({
                legacyId: candidate.id.startsWith("legacy:")
                    ? candidate.id.slice("legacy:".length)
                    : candidate.id,
                score: candidate.score,
            }));
        },
    });
    const receipt = composeClawLoreRuntimeV1({
        config: runtimeConfig,
        host: {
            on(event, handler, options) {
                api.on(event, handler, options);
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
                api.logger.debug?.(`clawlore: observer metrics active=${metrics.active} late=${metrics.late} timeouts=${metrics.timeouts} saturated=${metrics.saturated}`);
            },
        },
        readiness: rolloutControls.readiness,
    });
    api.logger.info(`clawlore: runtime status=${receipt.status} mode=${receipt.requestedMode} hooks=${receipt.registeredHooks.length} writes=${receipt.writeEnabled} promptMutation=${receipt.promptMutationEnabled} contextEngine=${receipt.contextEngineRegistered} blocks=${receipt.blockingReasons.join(",") || "none"}`);
}
