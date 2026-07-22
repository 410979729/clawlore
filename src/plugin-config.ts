import {
  normalizeAdmissionControlConfig,
  type AdmissionControlConfig,
} from "./admission-control.js";
import {
  isCanonicalPrincipalKey,
  type PrincipalIsolationConfig,
} from "./runtime-memory-boundary.js";
import {
  resolveClawLoreRuntimeRequestConfig,
  type ClawLoreRuntimeRequestConfig,
} from "./runtime-config.js";
import {
  DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG,
  type TaskExperienceCaptureConfig,
} from "./task-experience.js";
import type { WorkspaceBoundaryConfig } from "./workspace-boundary.js";
import type { ReflectionThinkLevel } from "./reflection-contracts.js";
import type { ManualRecallConfidenceConfig } from "./manual-recall-confidence.js";
export type { ReflectionThinkLevel } from "./reflection-contracts.js";

export type SessionStrategy = "memoryReflection" | "systemSessionMemory" | "none";
export type ReflectionInjectMode = "inheritance-only" | "inheritance+derived";

/**
 * Validated configuration consumed by the ClawLore composition root.
 *
 * This is an internal runtime contract, not the permissive host input shape.
 * `parsePluginConfig` must be the only boundary that converts unknown host
 * configuration into this type.
 */
export interface PluginConfig {
  embedding: {
    provider: "openai-compatible" | "azure-openai" | "local-hash" | "local-debug" | "minimax";
    apiKey?: string | string[];
    model?: string;
    baseURL?: string;
    dimensions?: number;
    groupId?: string;
    omitDimensions?: boolean;
    taskQuery?: string;
    taskPassage?: string;
    normalized?: boolean;
    chunking?: boolean;
  };
  dbPath?: string;
  vectorBackend?: "lancedb" | "sqlite-bruteforce";
  autoCapture?: boolean;
  /** Deprecated no-op retained only for config compatibility; true is a doctor error. */
  autoBackup?: boolean;
  autoRecall?: boolean;
  autoRecallMinLength?: number;
  autoRecallMinRepeated?: number;
  autoRecallTimeoutMs?: number;
  autoRecallQueryMaxChars?: number;
  autoRecallMaxItems?: number;
  autoRecallMaxChars?: number;
  autoRecallPerItemMaxChars?: number;
  autoRecallAllowCrossScope?: boolean;
  /** Hard per-turn injection cap. It overrides `autoRecallMaxItems` if lower. */
  maxRecallPerTurn?: number;
  recallMode?: "full" | "summary" | "adaptive" | "off";
  captureAssistant?: boolean;
  retrieval?: {
    mode?: "hybrid" | "vector";
    vectorWeight?: number;
    bm25Weight?: number;
    minScore?: number;
    rerank?: "cross-encoder" | "lightweight" | "none";
    candidatePoolSize?: number;
    rerankApiKey?: string;
    rerankModel?: string;
    rerankEndpoint?: string;
    rerankProvider?:
      | "jina"
      | "siliconflow"
      | "voyage"
      | "pinecone"
      | "dashscope"
      | "tei";
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    filterNoise?: boolean;
    lengthNormAnchor?: number;
    hardMinScore?: number;
    timeDecayHalfLifeDays?: number;
    reinforcementFactor?: number;
    maxHalfLifeMultiplier?: number;
  } & ManualRecallConfidenceConfig;
  decay?: {
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    frequencyWeight?: number;
    intrinsicWeight?: number;
    staleThreshold?: number;
    searchBoostMin?: number;
    importanceModulation?: number;
    betaCore?: number;
    betaWorking?: number;
    betaPeripheral?: number;
    coreDecayFloor?: number;
    workingDecayFloor?: number;
    peripheralDecayFloor?: number;
  };
  tier?: {
    coreAccessThreshold?: number;
    coreCompositeThreshold?: number;
    coreImportanceThreshold?: number;
    peripheralCompositeThreshold?: number;
    peripheralAgeDays?: number;
    workingAccessThreshold?: number;
    workingCompositeThreshold?: number;
  };
  smartExtraction?: boolean;
  llm?: {
    auth?: "api-key" | "oauth";
    apiKey?: string;
    model?: string;
    baseURL?: string;
    oauthProvider?: string;
    oauthPath?: string;
    timeoutMs?: number;
  };
  extractMinMessages?: number;
  extractMaxChars?: number;
  scopes?: {
    default?: string;
    definitions?: Record<string, { description: string }>;
    agentAccess?: Record<string, string[]>;
  };
  enableManagementTools?: boolean;
  allowAgentOperatorTools?: boolean;
  secretIndexToolsEnabled?: boolean;
  sessionStrategy?: SessionStrategy;
  sessionMemory?: { enabled?: boolean; messageCount?: number };
  selfImprovement?: {
    enabled?: boolean;
    beforeResetNote?: boolean;
    skipSubagentBootstrap?: boolean;
    ensureLearningFiles?: boolean;
  };
  memoryReflection?: {
    enabled?: boolean;
    storeToLanceDB?: boolean;
    writeLegacyCombined?: boolean;
    injectMode?: ReflectionInjectMode;
    agentId?: string;
    messageCount?: number;
    maxInputChars?: number;
    timeoutMs?: number;
    thinkLevel?: ReflectionThinkLevel;
    errorReminderMaxEntries?: number;
    dedupeErrorSignals?: boolean;
  };
  mdMirror?: { enabled?: boolean; dir?: string };
  workspaceBoundary?: WorkspaceBoundaryConfig;
  principalIsolation?: PrincipalIsolationConfig;
  admissionControl?: AdmissionControlConfig;
  memoryCompaction?: {
    enabled?: boolean;
    startupMode?: "off" | "dry-run";
    minAgeDays?: number;
    similarityThreshold?: number;
    minClusterSize?: number;
    maxMemoriesToScan?: number;
    cooldownHours?: number;
  };
  sessionCompression?: {
    enabled?: boolean;
    minScoreToKeep?: number;
  };
  extractionThrottle?: {
    skipLowValue?: boolean;
    maxExtractionsPerHour?: number;
  };
  taskExperienceCapture?: TaskExperienceCaptureConfig;
  runtime?: ClawLoreRuntimeRequestConfig;
}

export const DEFAULT_REFLECTION_MESSAGE_COUNT = 120;
export const DEFAULT_REFLECTION_MAX_INPUT_CHARS = 24_000;
export const DEFAULT_REFLECTION_TIMEOUT_MS = 20_000;
export const DEFAULT_REFLECTION_THINK_LEVEL: ReflectionThinkLevel = "medium";
export const DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES = 3;
export const DEFAULT_REFLECTION_DEDUPE_ERROR_SIGNALS = true;

function looksLikeUnresolvedSecretRef(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return ["env", "file", "exec"].includes(String(candidate.source))
    && typeof candidate.id === "string"
    && candidate.id.trim().length > 0;
}

/**
 * OpenClaw runtime registration is synchronous, so the host must materialize
 * manifest-declared SecretRefs before invoking the plugin. Assert that host
 * contract before strict parsing and fail with a direct boundary error.
 */
export function parseRuntimePluginConfig(value: unknown): PluginConfig {
  const pluginConfig = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const embedding = pluginConfig.embedding as Record<string, unknown> | undefined;
  const retrieval = pluginConfig.retrieval as Record<string, unknown> | undefined;
  const llm = pluginConfig.llm as Record<string, unknown> | undefined;
  const unresolved: string[] = [];
  if (embedding) {
    if (Array.isArray(embedding.apiKey)) {
      embedding.apiKey.forEach((entry, index) => {
        if (looksLikeUnresolvedSecretRef(entry)) unresolved.push(`embedding.apiKey.${index}`);
      });
    } else if (looksLikeUnresolvedSecretRef(embedding.apiKey)) {
      unresolved.push("embedding.apiKey");
    }
  }
  if (retrieval && looksLikeUnresolvedSecretRef(retrieval.rerankApiKey)) {
    unresolved.push("retrieval.rerankApiKey");
  }
  if (llm && looksLikeUnresolvedSecretRef(llm.apiKey)) unresolved.push("llm.apiKey");
  if (unresolved.length > 0) {
    throw new Error(
      `clawlore: OpenClaw did not resolve manifest-declared runtime SecretRefs before registration: ${unresolved.join(", ")}`,
    );
  }
  return parsePluginConfig(pluginConfig);
}

export function resolveConfigString(value: string): string {
  return value;
}

export function resolveFirstApiKey(apiKey: string | string[]): string {
  const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (!key) {
    throw new Error("embedding.apiKey is empty");
  }
  return key;
}

export const OPENAI_CLIENT_AUTH_FIELD = ["api", "Key"].join("");

export function assignOpenAiClientCredential<T extends object>(target: T, value: unknown): T {
  (target as Record<string, unknown>)[OPENAI_CLIENT_AUTH_FIELD] = value;
  return target;
}

export function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return undefined;
    const parsed = Number(resolveConfigString(raw));
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

export function parseNumberBetween(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(resolveConfigString(value.trim()))
      : NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, parsed));
}

function parseIntBetween(value: unknown, min: number, max: number): number | undefined {
  const parsed = parseNumberBetween(value, min, max);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function resolveLlmTimeoutMs(config: PluginConfig): number {
  return parsePositiveInt(config.llm?.timeoutMs) ?? 30_000;
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Validate and normalize unknown OpenClaw plugin input before composition. */
export function parsePluginConfig(value: unknown): PluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("clawlore config required");
  }
  const cfg = value as Record<string, unknown>;

  const embedding = cfg.embedding as Record<string, unknown> | undefined;
  if (!embedding) {
    throw new Error("embedding config is required");
  }

  const requestedProvider =
    embedding.provider === "azure-openai" ||
    embedding.provider === "local-hash" ||
    embedding.provider === "local-debug" ||
    embedding.provider === "minimax" ||
    embedding.provider === "openai-compatible"
      ? embedding.provider
      : undefined;
  const hasConfiguredEmbeddingCredential =
    typeof embedding.apiKey === "string"
      ? embedding.apiKey.trim().length > 0
      : Array.isArray(embedding.apiKey) && embedding.apiKey.length > 0;
  const embeddingProvider =
    requestedProvider ?? (hasConfiguredEmbeddingCredential ? "openai-compatible" : "local-hash");
  const localEmbeddingProvider = embeddingProvider === "local-hash" || embeddingProvider === "local-debug";

  let embeddingAuthMaterial: string | string[] | undefined;
  if (typeof embedding.apiKey === "string") {
    embeddingAuthMaterial = embedding.apiKey;
  } else if (Array.isArray(embedding.apiKey) && embedding.apiKey.length > 0) {
    const invalid = embedding.apiKey.findIndex(
      (key: unknown) => typeof key !== "string" || (key as string).trim().length === 0,
    );
    if (invalid !== -1) {
      throw new Error(`embedding.apiKey[${invalid}] is invalid: expected non-empty string`);
    }
    embeddingAuthMaterial = embedding.apiKey as string[];
  } else if (embedding.apiKey !== undefined) {
    throw new Error("embedding.apiKey must be a string or non-empty array of strings");
  }

  if (
    !localEmbeddingProvider &&
    (!embeddingAuthMaterial ||
      (Array.isArray(embeddingAuthMaterial) && embeddingAuthMaterial.length === 0))
  ) {
    throw new Error("embedding.apiKey is required for hosted embedding providers");
  }

  const memoryReflectionRaw = typeof cfg.memoryReflection === "object" && cfg.memoryReflection !== null
    ? cfg.memoryReflection as Record<string, unknown>
    : null;
  const sessionMemoryRaw = typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
    ? cfg.sessionMemory as Record<string, unknown>
    : null;
  const workspaceBoundaryRaw = typeof cfg.workspaceBoundary === "object" && cfg.workspaceBoundary !== null
    ? cfg.workspaceBoundary as Record<string, unknown>
    : null;
  const userMdExclusiveRaw =
    typeof workspaceBoundaryRaw?.userMdExclusive === "object" &&
    workspaceBoundaryRaw.userMdExclusive !== null
      ? workspaceBoundaryRaw.userMdExclusive as Record<string, unknown>
      : null;
  const legacySessionMemoryEnabled = typeof sessionMemoryRaw?.enabled === "boolean"
    ? sessionMemoryRaw.enabled
    : undefined;
  const sessionStrategy: SessionStrategy =
    cfg.sessionStrategy === "systemSessionMemory" ||
    cfg.sessionStrategy === "memoryReflection" ||
    cfg.sessionStrategy === "none"
      ? cfg.sessionStrategy
      : legacySessionMemoryEnabled === true
        ? "systemSessionMemory"
        : "none";
  const reflectionMessageCount =
    parsePositiveInt(memoryReflectionRaw?.messageCount ?? sessionMemoryRaw?.messageCount) ??
    DEFAULT_REFLECTION_MESSAGE_COUNT;
  const reflectionInjectMode: ReflectionInjectMode =
    memoryReflectionRaw?.injectMode === "inheritance-only" ||
    memoryReflectionRaw?.injectMode === "inheritance+derived"
      ? memoryReflectionRaw.injectMode
      : "inheritance+derived";
  const reflectionStoreToLanceDB =
    sessionStrategy === "memoryReflection" && memoryReflectionRaw?.storeToLanceDB !== false;

  return {
    embedding: {
      provider: embeddingProvider,
      [OPENAI_CLIENT_AUTH_FIELD]: embeddingAuthMaterial,
      model:
        typeof embedding.model === "string"
          ? embedding.model
          : localEmbeddingProvider
            ? embeddingProvider === "local-debug" ? "debug-hash-v1" : "hash-v1"
            : embeddingProvider === "minimax"
              ? "embo-01"
              : "text-embedding-3-small",
      baseURL:
        typeof embedding.baseURL === "string"
          ? resolveConfigString(embedding.baseURL)
          : undefined,
      dimensions: parsePositiveInt(embedding.dimensions ?? cfg.dimensions),
      omitDimensions:
        typeof embedding.omitDimensions === "boolean" ? embedding.omitDimensions : undefined,
      taskQuery: typeof embedding.taskQuery === "string" ? embedding.taskQuery : undefined,
      taskPassage: typeof embedding.taskPassage === "string" ? embedding.taskPassage : undefined,
      normalized: typeof embedding.normalized === "boolean" ? embedding.normalized : undefined,
      chunking: typeof embedding.chunking === "boolean" ? embedding.chunking : undefined,
      groupId:
        typeof embedding.groupId === "string"
          ? resolveConfigString(embedding.groupId)
          : undefined,
    },
    dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : undefined,
    vectorBackend:
      cfg.vectorBackend === "sqlite-bruteforce" || cfg.vectorBackend === "lancedb"
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
    recallMode:
      cfg.recallMode === "full" ||
      cfg.recallMode === "summary" ||
      cfg.recallMode === "adaptive" ||
      cfg.recallMode === "off"
        ? cfg.recallMode
        : "full",
    captureAssistant: cfg.captureAssistant === true,
    retrieval: typeof cfg.retrieval === "object" && cfg.retrieval !== null ? cfg.retrieval as any : undefined,
    decay: typeof cfg.decay === "object" && cfg.decay !== null ? cfg.decay as any : undefined,
    tier: typeof cfg.tier === "object" && cfg.tier !== null ? cfg.tier as any : undefined,
    smartExtraction: cfg.smartExtraction === true,
    llm: typeof cfg.llm === "object" && cfg.llm !== null ? cfg.llm as any : undefined,
    extractMinMessages: parsePositiveInt(cfg.extractMinMessages) ?? 4,
    extractMaxChars: parsePositiveInt(cfg.extractMaxChars) ?? 8_000,
    scopes: typeof cfg.scopes === "object" && cfg.scopes !== null ? cfg.scopes as any : undefined,
    enableManagementTools: cfg.enableManagementTools === true,
    allowAgentOperatorTools: cfg.allowAgentOperatorTools === true,
    sessionStrategy,
    selfImprovement: typeof cfg.selfImprovement === "object" && cfg.selfImprovement !== null
      ? {
        enabled: (cfg.selfImprovement as Record<string, unknown>).enabled === true,
        beforeResetNote: (cfg.selfImprovement as Record<string, unknown>).beforeResetNote !== false,
        skipSubagentBootstrap: (cfg.selfImprovement as Record<string, unknown>).skipSubagentBootstrap !== false,
        ensureLearningFiles: (cfg.selfImprovement as Record<string, unknown>).ensureLearningFiles !== false,
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
        maxInputChars:
          parsePositiveInt(memoryReflectionRaw.maxInputChars) ?? DEFAULT_REFLECTION_MAX_INPUT_CHARS,
        timeoutMs: parsePositiveInt(memoryReflectionRaw.timeoutMs) ?? DEFAULT_REFLECTION_TIMEOUT_MS,
        thinkLevel: (() => {
          const raw = memoryReflectionRaw.thinkLevel;
          if (raw === "off" || raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") {
            return raw;
          }
          return DEFAULT_REFLECTION_THINK_LEVEL;
        })(),
        errorReminderMaxEntries:
          parsePositiveInt(memoryReflectionRaw.errorReminderMaxEntries) ??
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
    sessionMemory:
      typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
        ? {
          enabled: (cfg.sessionMemory as Record<string, unknown>).enabled === true,
          messageCount:
            typeof (cfg.sessionMemory as Record<string, unknown>).messageCount === "number"
              ? (cfg.sessionMemory as Record<string, unknown>).messageCount as number
              : undefined,
        }
        : undefined,
    mdMirror:
      typeof cfg.mdMirror === "object" && cfg.mdMirror !== null
        ? {
          enabled: (cfg.mdMirror as Record<string, unknown>).enabled === true,
          dir:
            typeof (cfg.mdMirror as Record<string, unknown>).dir === "string"
              ? (cfg.mdMirror as Record<string, unknown>).dir as string
              : undefined,
        }
        : undefined,
    workspaceBoundary:
      workspaceBoundaryRaw
        ? {
          userMdExclusive:
            userMdExclusiveRaw
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
        ? cfg.principalIsolation as Record<string, unknown>
        : null;
      return {
        enabled: raw?.enabled !== false,
        groupMemory: raw?.groupMemory === "conversation" ? "conversation" : "deny",
        legacyAgentScopePrincipals: Array.isArray(raw?.legacyAgentScopePrincipals)
          ? (raw.legacyAgentScopePrincipals as unknown[]).map((entry, index) => {
            if (!isCanonicalPrincipalKey(entry)) {
              throw new Error(
                `principalIsolation.legacyAgentScopePrincipals[${index}] must be an exact canonical platform:account:principal key`,
              );
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
        ? cfg.memoryCompaction as Record<string, unknown>
        : null;
      if (!raw) return undefined;
      return {
        enabled: raw.enabled === true,
        startupMode: raw.startupMode === "dry-run" ? "dry-run" : "off",
        minAgeDays: parsePositiveInt(raw.minAgeDays) ?? 7,
        similarityThreshold:
          typeof raw.similarityThreshold === "number"
            ? Math.max(0, Math.min(1, raw.similarityThreshold))
            : 0.88,
        minClusterSize: parsePositiveInt(raw.minClusterSize) ?? 2,
        maxMemoriesToScan: parsePositiveInt(raw.maxMemoriesToScan) ?? 200,
        cooldownHours: parsePositiveInt(raw.cooldownHours) ?? 24,
      };
    })(),
    sessionCompression:
      typeof cfg.sessionCompression === "object" && cfg.sessionCompression !== null
        ? {
          enabled: (cfg.sessionCompression as Record<string, unknown>).enabled === true,
          minScoreToKeep:
            typeof (cfg.sessionCompression as Record<string, unknown>).minScoreToKeep === "number"
              ? (cfg.sessionCompression as Record<string, unknown>).minScoreToKeep as number
              : 0.3,
        }
        : { enabled: false, minScoreToKeep: 0.3 },
    extractionThrottle:
      typeof cfg.extractionThrottle === "object" && cfg.extractionThrottle !== null
        ? {
          skipLowValue: (cfg.extractionThrottle as Record<string, unknown>).skipLowValue === true,
          maxExtractionsPerHour:
            typeof (cfg.extractionThrottle as Record<string, unknown>).maxExtractionsPerHour === "number"
              ? (cfg.extractionThrottle as Record<string, unknown>).maxExtractionsPerHour as number
              : 30,
        }
        : { skipLowValue: false, maxExtractionsPerHour: 30 },
    taskExperienceCapture: (() => {
      const raw = typeof cfg.taskExperienceCapture === "object" && cfg.taskExperienceCapture !== null
        ? cfg.taskExperienceCapture as Record<string, unknown>
        : null;
      if (!raw) return { ...DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG };
      return {
        enabled: raw.enabled === true,
        minMessages:
          parseIntBetween(raw.minMessages, 2, 200) ?? DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.minMessages,
        minToolCalls:
          parseIntBetween(raw.minToolCalls, 0, 50) ?? DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.minToolCalls,
        maxInputChars:
          parseIntBetween(raw.maxInputChars, 1_000, 100_000) ??
          DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.maxInputChars,
        maxCapsuleChars:
          parseIntBetween(raw.maxCapsuleChars, 800, 8_000) ??
          DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.maxCapsuleChars,
        minConfidence:
          parseNumberBetween(raw.minConfidence, 0, 1) ??
          DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.minConfidence,
        dedupeThreshold:
          parseNumberBetween(raw.dedupeThreshold, 0, 1) ??
          DEFAULT_TASK_EXPERIENCE_CAPTURE_CONFIG.dedupeThreshold,
      };
    })(),
    runtime: resolveClawLoreRuntimeRequestConfig(cfg),
  };
}
