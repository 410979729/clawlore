import { normalizeAdmissionControlConfig, } from "./admission-control.js";
import { isCanonicalPrincipalKey, } from "./runtime-memory-boundary.js";
import { resolveClawLoreRuntimeRequestConfig, } from "./runtime-config.js";
import { DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG, } from "./task-experience.js";
export const DEFAULT_REFLECTION_MESSAGE_COUNT = 120;
export const DEFAULT_REFLECTION_MAX_INPUT_CHARS = 24_000;
export const DEFAULT_REFLECTION_TIMEOUT_MS = 20_000;
export const DEFAULT_REFLECTION_THINK_LEVEL = "medium";
export const DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES = 3;
export const DEFAULT_REFLECTION_DEDUPE_ERROR_SIGNALS = true;
export const MAX_EMBEDDING_API_KEYS = 8;
function looksLikeUnresolvedSecretRef(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const candidate = value;
    return ["env", "file", "exec"].includes(String(candidate.source))
        && typeof candidate.id === "string"
        && candidate.id.trim().length > 0;
}
/**
 * OpenClaw runtime registration is synchronous, so the host must materialize
 * manifest-declared SecretRefs before invoking the plugin. Assert that host
 * contract before strict parsing and fail with a direct boundary error.
 */
export function parseRuntimePluginConfig(value) {
    const pluginConfig = value && typeof value === "object"
        ? value
        : {};
    const embedding = pluginConfig.embedding;
    const retrieval = pluginConfig.retrieval;
    const llm = pluginConfig.llm;
    const unresolved = [];
    if (embedding) {
        if (Array.isArray(embedding.apiKey)) {
            embedding.apiKey.forEach((entry, index) => {
                if (looksLikeUnresolvedSecretRef(entry))
                    unresolved.push(`embedding.apiKey.${index}`);
            });
        }
        else if (looksLikeUnresolvedSecretRef(embedding.apiKey)) {
            unresolved.push("embedding.apiKey");
        }
    }
    if (retrieval && looksLikeUnresolvedSecretRef(retrieval.rerankApiKey)) {
        unresolved.push("retrieval.rerankApiKey");
    }
    if (llm && looksLikeUnresolvedSecretRef(llm.apiKey))
        unresolved.push("llm.apiKey");
    if (unresolved.length > 0) {
        throw new Error(`clawlore: OpenClaw did not resolve manifest-declared runtime SecretRefs before registration: ${unresolved.join(", ")}`);
    }
    return parsePluginConfig(pluginConfig);
}
export function resolveConfigString(value) {
    return value;
}
export function resolveFirstApiKey(apiKey) {
    const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    if (!key) {
        throw new Error("embedding.apiKey is empty");
    }
    return key;
}
export const OPENAI_CLIENT_AUTH_FIELD = ["api", "Key"].join("");
export function assignOpenAiClientCredential(target, value) {
    target[OPENAI_CLIENT_AUTH_FIELD] = value;
    return target;
}
export function parsePositiveInt(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === "string") {
        const raw = value.trim();
        if (!raw)
            return undefined;
        const parsed = Number(resolveConfigString(raw));
        if (Number.isFinite(parsed) && parsed > 0)
            return Math.floor(parsed);
    }
    return undefined;
}
export function parseNumberBetween(value, min, max) {
    const parsed = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
            ? Number(resolveConfigString(value.trim()))
            : NaN;
    if (!Number.isFinite(parsed))
        return undefined;
    return Math.min(max, Math.max(min, parsed));
}
function parseIntBetween(value, min, max) {
    const parsed = parseNumberBetween(value, min, max);
    return parsed === undefined ? undefined : Math.floor(parsed);
}
export function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
export function resolveLlmTimeoutMs(config) {
    return parsePositiveInt(config.llm?.timeoutMs) ?? 30_000;
}
export function asNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
/** Validate and normalize unknown OpenClaw plugin input before composition. */
export function parsePluginConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("clawlore config required");
    }
    const cfg = value;
    const embedding = cfg.embedding;
    if (!embedding) {
        throw new Error("embedding config is required");
    }
    const requestedProvider = embedding.provider === "azure-openai" ||
        embedding.provider === "local-hash" ||
        embedding.provider === "local-debug" ||
        embedding.provider === "minimax" ||
        embedding.provider === "openai-compatible"
        ? embedding.provider
        : undefined;
    const hasConfiguredEmbeddingCredential = typeof embedding.apiKey === "string"
        ? embedding.apiKey.trim().length > 0
        : Array.isArray(embedding.apiKey) && embedding.apiKey.length > 0;
    const embeddingProvider = requestedProvider ?? (hasConfiguredEmbeddingCredential ? "openai-compatible" : "local-hash");
    const localEmbeddingProvider = embeddingProvider === "local-hash" || embeddingProvider === "local-debug";
    let embeddingAuthMaterial;
    if (typeof embedding.apiKey === "string") {
        embeddingAuthMaterial = embedding.apiKey;
    }
    else if (Array.isArray(embedding.apiKey) && embedding.apiKey.length > 0) {
        if (embedding.apiKey.length > MAX_EMBEDDING_API_KEYS) {
            throw new Error(`embedding.apiKey supports at most ${MAX_EMBEDDING_API_KEYS} entries`);
        }
        const invalid = embedding.apiKey.findIndex((key) => typeof key !== "string" || key.trim().length === 0);
        if (invalid !== -1) {
            throw new Error(`embedding.apiKey[${invalid}] is invalid: expected non-empty string`);
        }
        embeddingAuthMaterial = embedding.apiKey;
    }
    else if (embedding.apiKey !== undefined) {
        throw new Error("embedding.apiKey must be a string or non-empty array of strings");
    }
    if (!localEmbeddingProvider &&
        (!embeddingAuthMaterial ||
            (Array.isArray(embeddingAuthMaterial) && embeddingAuthMaterial.length === 0))) {
        throw new Error("embedding.apiKey is required for hosted embedding providers");
    }
    const memoryReflectionRaw = typeof cfg.memoryReflection === "object" && cfg.memoryReflection !== null
        ? cfg.memoryReflection
        : null;
    const sessionMemoryRaw = typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
        ? cfg.sessionMemory
        : null;
    const workspaceBoundaryRaw = typeof cfg.workspaceBoundary === "object" && cfg.workspaceBoundary !== null
        ? cfg.workspaceBoundary
        : null;
    const userMdExclusiveRaw = typeof workspaceBoundaryRaw?.userMdExclusive === "object" &&
        workspaceBoundaryRaw.userMdExclusive !== null
        ? workspaceBoundaryRaw.userMdExclusive
        : null;
    const legacySessionMemoryEnabled = typeof sessionMemoryRaw?.enabled === "boolean"
        ? sessionMemoryRaw.enabled
        : undefined;
    const sessionStrategy = cfg.sessionStrategy === "systemSessionMemory" ||
        cfg.sessionStrategy === "memoryReflection" ||
        cfg.sessionStrategy === "none"
        ? cfg.sessionStrategy
        : legacySessionMemoryEnabled === true
            ? "systemSessionMemory"
            : "none";
    const reflectionMessageCount = parsePositiveInt(memoryReflectionRaw?.messageCount ?? sessionMemoryRaw?.messageCount) ??
        DEFAULT_REFLECTION_MESSAGE_COUNT;
    const reflectionInjectMode = memoryReflectionRaw?.injectMode === "inheritance-only" ||
        memoryReflectionRaw?.injectMode === "inheritance+derived"
        ? memoryReflectionRaw.injectMode
        : "inheritance+derived";
    const reflectionStoreToLanceDB = sessionStrategy === "memoryReflection" && memoryReflectionRaw?.storeToLanceDB !== false;
    return {
        embedding: {
            provider: embeddingProvider,
            [OPENAI_CLIENT_AUTH_FIELD]: embeddingAuthMaterial,
            model: typeof embedding.model === "string"
                ? embedding.model
                : localEmbeddingProvider
                    ? embeddingProvider === "local-debug" ? "debug-hash-v1" : "hash-v1"
                    : embeddingProvider === "minimax"
                        ? "embo-01"
                        : "text-embedding-3-small",
            baseURL: typeof embedding.baseURL === "string"
                ? resolveConfigString(embedding.baseURL)
                : undefined,
            dimensions: parsePositiveInt(embedding.dimensions ?? cfg.dimensions),
            omitDimensions: typeof embedding.omitDimensions === "boolean" ? embedding.omitDimensions : undefined,
            taskQuery: typeof embedding.taskQuery === "string" ? embedding.taskQuery : undefined,
            taskPassage: typeof embedding.taskPassage === "string" ? embedding.taskPassage : undefined,
            normalized: typeof embedding.normalized === "boolean" ? embedding.normalized : undefined,
            chunking: typeof embedding.chunking === "boolean" ? embedding.chunking : undefined,
            groupId: typeof embedding.groupId === "string"
                ? resolveConfigString(embedding.groupId)
                : undefined,
        },
        dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : undefined,
        vectorBackend: cfg.vectorBackend === "sqlite-bruteforce" || cfg.vectorBackend === "lancedb"
            ? cfg.vectorBackend
            : "lancedb",
        autoCapture: cfg.autoCapture === true,
        autoBackup: cfg.autoBackup === true,
        autoRecall: cfg.autoRecall === true,
        autoRecallMinLength: parsePositiveInt(cfg.autoRecallMinLength),
        autoRecallMinRepeated: parsePositiveInt(cfg.autoRecallMinRepeated) ?? 8,
        autoRecallTimeoutMs: parsePositiveInt(cfg.autoRecallTimeoutMs) ?? 5_000,
        autoRecallQueryMaxChars: parseIntBetween(cfg.autoRecallQueryMaxChars, 256, 12_000) ?? 4_000,
        autoRecallMaxItems: parsePositiveInt(cfg.autoRecallMaxItems) ?? 3,
        autoRecallMaxChars: parsePositiveInt(cfg.autoRecallMaxChars) ?? 600,
        autoRecallPerItemMaxChars: parsePositiveInt(cfg.autoRecallPerItemMaxChars) ?? 180,
        maxRecallPerTurn: parsePositiveInt(cfg.maxRecallPerTurn) ?? 10,
        recallMode: cfg.recallMode === "full" ||
            cfg.recallMode === "summary" ||
            cfg.recallMode === "adaptive" ||
            cfg.recallMode === "off"
            ? cfg.recallMode
            : "full",
        captureAssistant: cfg.captureAssistant === true,
        retrieval: typeof cfg.retrieval === "object" && cfg.retrieval !== null ? cfg.retrieval : undefined,
        decay: typeof cfg.decay === "object" && cfg.decay !== null ? cfg.decay : undefined,
        tier: typeof cfg.tier === "object" && cfg.tier !== null ? cfg.tier : undefined,
        smartExtraction: cfg.smartExtraction === true,
        llm: typeof cfg.llm === "object" && cfg.llm !== null ? cfg.llm : undefined,
        extractMinMessages: parsePositiveInt(cfg.extractMinMessages) ?? 4,
        extractMaxChars: parsePositiveInt(cfg.extractMaxChars) ?? 8_000,
        scopes: typeof cfg.scopes === "object" && cfg.scopes !== null ? cfg.scopes : undefined,
        enableManagementTools: cfg.enableManagementTools === true,
        allowAgentOperatorTools: cfg.allowAgentOperatorTools === true,
        sessionStrategy,
        selfImprovement: typeof cfg.selfImprovement === "object" && cfg.selfImprovement !== null
            ? {
                enabled: cfg.selfImprovement.enabled === true,
                beforeResetNote: cfg.selfImprovement.beforeResetNote !== false,
                skipSubagentBootstrap: cfg.selfImprovement.skipSubagentBootstrap !== false,
                ensureLearningFiles: cfg.selfImprovement.ensureLearningFiles !== false,
            }
            : {
                enabled: false,
                beforeResetNote: true,
                skipSubagentBootstrap: true,
                ensureLearningFiles: true,
            },
        memoryReflection: memoryReflectionRaw
            ? {
                enabled: sessionStrategy === "memoryReflection",
                storeToLanceDB: reflectionStoreToLanceDB,
                writeLegacyCombined: memoryReflectionRaw.writeLegacyCombined !== false,
                injectMode: reflectionInjectMode,
                agentId: asNonEmptyString(memoryReflectionRaw.agentId),
                messageCount: reflectionMessageCount,
                maxInputChars: parsePositiveInt(memoryReflectionRaw.maxInputChars) ?? DEFAULT_REFLECTION_MAX_INPUT_CHARS,
                timeoutMs: parsePositiveInt(memoryReflectionRaw.timeoutMs) ?? DEFAULT_REFLECTION_TIMEOUT_MS,
                thinkLevel: (() => {
                    const raw = memoryReflectionRaw.thinkLevel;
                    if (raw === "off" || raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") {
                        return raw;
                    }
                    return DEFAULT_REFLECTION_THINK_LEVEL;
                })(),
                errorReminderMaxEntries: parsePositiveInt(memoryReflectionRaw.errorReminderMaxEntries) ??
                    DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES,
                dedupeErrorSignals: memoryReflectionRaw.dedupeErrorSignals !== false,
            }
            : {
                enabled: sessionStrategy === "memoryReflection",
                storeToLanceDB: reflectionStoreToLanceDB,
                writeLegacyCombined: true,
                injectMode: "inheritance+derived",
                agentId: undefined,
                messageCount: reflectionMessageCount,
                maxInputChars: DEFAULT_REFLECTION_MAX_INPUT_CHARS,
                timeoutMs: DEFAULT_REFLECTION_TIMEOUT_MS,
                thinkLevel: DEFAULT_REFLECTION_THINK_LEVEL,
                errorReminderMaxEntries: DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES,
                dedupeErrorSignals: DEFAULT_REFLECTION_DEDUPE_ERROR_SIGNALS,
            },
        sessionMemory: typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
            ? {
                enabled: cfg.sessionMemory.enabled === true,
                messageCount: typeof cfg.sessionMemory.messageCount === "number"
                    ? cfg.sessionMemory.messageCount
                    : undefined,
            }
            : undefined,
        mdMirror: typeof cfg.mdMirror === "object" && cfg.mdMirror !== null
            ? {
                enabled: cfg.mdMirror.enabled === true,
                dir: typeof cfg.mdMirror.dir === "string"
                    ? cfg.mdMirror.dir
                    : undefined,
            }
            : undefined,
        workspaceBoundary: workspaceBoundaryRaw
            ? {
                userMdExclusive: userMdExclusiveRaw
                    ? {
                        enabled: userMdExclusiveRaw.enabled === true,
                        routeProfile: userMdExclusiveRaw.routeProfile !== false,
                        routeCanonicalName: userMdExclusiveRaw.routeCanonicalName !== false,
                        routeCanonicalAddressing: userMdExclusiveRaw.routeCanonicalAddressing !== false,
                        filterRecall: userMdExclusiveRaw.filterRecall !== false,
                    }
                    : undefined,
            }
            : undefined,
        principalIsolation: (() => {
            const raw = typeof cfg.principalIsolation === "object" && cfg.principalIsolation !== null
                ? cfg.principalIsolation
                : null;
            return {
                enabled: raw?.enabled !== false,
                groupMemory: raw?.groupMemory === "conversation" ? "conversation" : "deny",
                legacyAgentScopePrincipals: Array.isArray(raw?.legacyAgentScopePrincipals)
                    ? raw.legacyAgentScopePrincipals.map((entry, index) => {
                        if (!isCanonicalPrincipalKey(entry)) {
                            throw new Error(`principalIsolation.legacyAgentScopePrincipals[${index}] must be an exact canonical platform:account:principal key`);
                        }
                        return entry;
                    })
                    : [],
                allowGlobalRead: raw?.allowGlobalRead === true,
            };
        })(),
        admissionControl: normalizeAdmissionControlConfig(cfg.admissionControl),
        memoryCompaction: (() => {
            const raw = typeof cfg.memoryCompaction === "object" && cfg.memoryCompaction !== null
                ? cfg.memoryCompaction
                : null;
            if (!raw)
                return undefined;
            return {
                enabled: raw.enabled === true,
                startupMode: raw.startupMode === "dry-run" ? "dry-run" : "off",
                minAgeDays: parsePositiveInt(raw.minAgeDays) ?? 7,
                similarityThreshold: typeof raw.similarityThreshold === "number"
                    ? Math.max(0, Math.min(1, raw.similarityThreshold))
                    : 0.88,
                minClusterSize: parsePositiveInt(raw.minClusterSize) ?? 2,
                maxMemoriesToScan: parsePositiveInt(raw.maxMemoriesToScan) ?? 200,
                cooldownHours: parsePositiveInt(raw.cooldownHours) ?? 24,
            };
        })(),
        sessionCompression: typeof cfg.sessionCompression === "object" && cfg.sessionCompression !== null
            ? {
                enabled: cfg.sessionCompression.enabled === true,
                minScoreToKeep: typeof cfg.sessionCompression.minScoreToKeep === "number"
                    ? cfg.sessionCompression.minScoreToKeep
                    : 0.3,
            }
            : { enabled: false, minScoreToKeep: 0.3 },
        extractionThrottle: typeof cfg.extractionThrottle === "object" && cfg.extractionThrottle !== null
            ? {
                skipLowValue: cfg.extractionThrottle.skipLowValue === true,
                maxExtractionsPerHour: typeof cfg.extractionThrottle.maxExtractionsPerHour === "number"
                    ? cfg.extractionThrottle.maxExtractionsPerHour
                    : 30,
            }
            : { skipLowValue: false, maxExtractionsPerHour: 30 },
        taskExperienceCapture: (() => {
            const raw = typeof cfg.taskExperienceCapture === "object" && cfg.taskExperienceCapture !== null
                ? cfg.taskExperienceCapture
                : null;
            if (!raw)
                return { ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG };
            return {
                enabled: raw.enabled === true,
                minMessages: parseIntBetween(raw.minMessages, 2, 200) ?? DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.minMessages,
                minToolCalls: parseIntBetween(raw.minToolCalls, 0, 50) ?? DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.minToolCalls,
                maxInputChars: parseIntBetween(raw.maxInputChars, 1_000, 100_000) ??
                    DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.maxInputChars,
                maxCapsuleChars: parseIntBetween(raw.maxCapsuleChars, 800, 8_000) ??
                    DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.maxCapsuleChars,
                minConfidence: parseNumberBetween(raw.minConfidence, 0, 1) ??
                    DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.minConfidence,
                dedupeThreshold: parseNumberBetween(raw.dedupeThreshold, 0, 1) ??
                    DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.dedupeThreshold,
            };
        })(),
        runtime: resolveClawLoreRuntimeRequestConfig(cfg),
    };
}
