import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createHash } from "node:crypto";

import { evaluateCaptureSafety } from "./capture-safety.js";
import { diagnosticErrorSummary, diagnosticIdentifier } from "./diagnostic-redaction.js";
import type { createEmbedder } from "./embedder.js";
import type { MarkdownMirrorWriter } from "./markdown-mirror.js";
import {
  asNonEmptyString,
  DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES,
  DEFAULT_REFLECTION_MAX_INPUT_CHARS,
  DEFAULT_REFLECTION_MESSAGE_COUNT,
  DEFAULT_REFLECTION_THINK_LEVEL,
  DEFAULT_REFLECTION_TIMEOUT_MS,
  parsePositiveInt,
  type PluginConfig,
} from "./plugin-config.js";
import { createReflectionCommandOrchestrator } from "./reflection-command-orchestrator.js";
import { createReflectionEventId } from "./reflection-event-store.js";
import { createReflectionTextGenerator } from "./reflection-generation.js";
import type { ReflectionRuntimeState } from "./reflection-runtime-state.js";
import { resolveReflectionSessionSearchDirs } from "./session-recovery.js";
import { appendSelfImprovementEntry } from "./self-improvement-files.js";
import { storeReflectionToLanceDB } from "./reflection-store.js";
import {
  readSessionConversationWithResetFallback,
  redactReflectionText,
  summarizeRecentConversationMessages,
} from "./reflection-transcript.js";
import type { resolveRuntimeMemoryAccess } from "./runtime-memory-boundary.js";
import { isSystemBypassId, type createScopeManager } from "./scopes.js";
import { buildSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import type { MemoryStore } from "./store.js";

const ERROR_SCAN_MAX_CHARS = 8_000;

type RuntimeAccessResolver = (
  event: unknown,
  context: any,
) => { agentId: string; access: ReturnType<typeof resolveRuntimeMemoryAccess> };

function isInternalSession(sessionKey: unknown): boolean {
  return typeof sessionKey === "string" && sessionKey.trim().startsWith("temp:memory-reflection");
}

function containsErrorSignal(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\[error\]|error:|exception:|fatal:|traceback|syntaxerror|typeerror|referenceerror|npm err!/.test(normalized)
    || /command not found|no such file|permission denied|non-zero|exit code/.test(normalized)
    || /"status"\s*:\s*"error"|"status"\s*:\s*"failed"|\biserror\b/.test(normalized)
    || /错误\s*[：:]|异常\s*[：:]|报错\s*[：:]|失败\s*[：:]/.test(normalized)
  );
}

function summarizeErrorText(text: string, maxLen = 220): string {
  const oneLine = redactReflectionText(text).replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty tool error)";
  return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen - 3)}...`;
}

function normalizeErrorSignature(text: string): string {
  return redactReflectionText(String(text || ""))
    .toLowerCase()
    .replace(/[a-z]:\\[^ \n\r\t]+/gi, "<path>")
    .replace(/\/[^ \n\r\t]+/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function extractTextFromToolResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const parts = record.content
        .filter((item) => item && typeof item === "object")
        .map((item) => (item as Record<string, unknown>).text)
        .filter((text): text is string => typeof text === "string");
      if (parts.length > 0) return parts.join("\n");
    }
    if (typeof record.text === "string") return record.text;
    if (typeof record.error === "string") return record.error;
    if (typeof record.details === "string") return record.details;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

function resolveSourceFromSessionKey(sessionKey: string | undefined): string {
  const match = (sessionKey?.trim() ?? "").match(/^agent:[^:]+:([^:]+)/);
  return match?.[1]?.trim() || "unknown";
}

/** Registers reflection, derived-focus, error-reminder, and typed session-summary hooks. */
export function registerReflectionHooks(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  store: MemoryStore;
  embedder: ReturnType<typeof createEmbedder>;
  scopeManager: ReturnType<typeof createScopeManager>;
  state: ReflectionRuntimeState;
  mdMirror: MarkdownMirrorWriter | null;
  resolveRuntimeAccess: RuntimeAccessResolver;
  resolveWorkspaceDir(context: Record<string, unknown> | undefined): string;
  resolveAgentId(explicitAgentId: string | undefined, sessionKey: string | undefined): string;
  logRegistration(message: string): void;
}): void {
  const { api, config, store, embedder, scopeManager, state } = params;
  if (config.sessionStrategy === "memoryReflection") {
    const reflectionConfig = config.memoryReflection;
    const messageCount = reflectionConfig?.messageCount ?? DEFAULT_REFLECTION_MESSAGE_COUNT;
    const maxInputChars = reflectionConfig?.maxInputChars ?? DEFAULT_REFLECTION_MAX_INPUT_CHARS;
    const timeoutMs = reflectionConfig?.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
    const thinkLevel = reflectionConfig?.thinkLevel ?? DEFAULT_REFLECTION_THINK_LEVEL;
    const configuredAgentId = asNonEmptyString(reflectionConfig?.agentId);
    const errorMaxEntries = parsePositiveInt(reflectionConfig?.errorReminderMaxEntries)
      ?? DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES;
    const dedupeErrors = reflectionConfig?.dedupeErrorSignals !== false;
    const injectMode = reflectionConfig?.injectMode ?? "inheritance+derived";

    api.on("after_tool_call", (event: any, ctx: any) => {
      const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      if (isInternalSession(sessionKey) || !sessionKey) return;
      state.prune();
      const addSignal = (text: string, source: "tool_error" | "tool_output") => {
        const signature = normalizeErrorSignature(text);
        state.addError(sessionKey, {
          at: Date.now(),
          toolName: event.toolName || "unknown",
          summary: summarizeErrorText(text),
          source,
          signature,
          signatureHash: createHash("sha256").update(signature, "utf8").digest("hex").slice(0, 16),
        }, dedupeErrors);
      };
      if (typeof event.error === "string" && event.error.trim()) {
        addSignal(event.error, "tool_error");
        return;
      }
      const raw = extractTextFromToolResult(event.result);
      const text = raw.length > ERROR_SCAN_MAX_CHARS ? raw.slice(0, ERROR_SCAN_MAX_CHARS) : raw;
      if (text && containsErrorSignal(text)) addSignal(text, "tool_output");
    }, { priority: 15 });

    api.on("before_prompt_build", async (event: any, ctx: any) => {
      const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      if (isInternalSession(sessionKey)) return;
      if (injectMode !== "inheritance-only" && injectMode !== "inheritance+derived") return;
      try {
        const { access } = params.resolveRuntimeAccess(event, ctx);
        if (access.denied) return;
        state.prune();
        const agentId = params.resolveAgentId(
          typeof ctx.agentId === "string" ? ctx.agentId : undefined,
          sessionKey,
        );
        const slices = await state.loadAgentSlices(agentId, access.scopeFilter);
        if (slices.invariants.length === 0) return;
        return {
          prependContext: [
            "<inherited-rules>",
            "Stable rules inherited from clawlore reflections. Treat as long-term behavioral constraints unless user overrides.",
            slices.invariants.slice(0, 6).map((line, index) => `${index + 1}. ${line}`).join("\n"),
            "</inherited-rules>",
          ].join("\n"),
        };
      } catch (error) {
        api.logger.warn(`memory-reflection: inheritance injection failed: ${diagnosticErrorSummary(error)}`);
      }
    }, { priority: 12 });

    api.on("before_prompt_build", async (event: any, ctx: any) => {
      const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
      if (isInternalSession(sessionKey)) return;
      const { access } = params.resolveRuntimeAccess(event, ctx);
      if (access.denied) return;
      const agentId = params.resolveAgentId(
        typeof ctx.agentId === "string" ? ctx.agentId : undefined,
        sessionKey,
      );
      state.prune();
      const blocks: string[] = [];
      if (injectMode === "inheritance+derived") {
        try {
          const cached = sessionKey ? state.getDerived(sessionKey) : [];
          const derived = cached.length > 0
            ? cached
            : (await state.loadAgentSlices(agentId, access.scopeFilter)).derived;
          if (derived.length > 0) {
            blocks.push([
              "<derived-focus>",
              "Weighted recent derived execution deltas from reflection memory:",
              ...derived.slice(0, 6).map((line, index) => `${index + 1}. ${line}`),
              "</derived-focus>",
            ].join("\n"));
          }
        } catch (error) {
          api.logger.warn(`memory-reflection: derived injection failed: ${diagnosticErrorSummary(error)}`);
        }
      }
      if (sessionKey) {
        const pending = state.pendingErrors(sessionKey, errorMaxEntries);
        if (pending.length > 0) {
          blocks.push([
            "<error-detected>",
            "A tool error was detected. Consider logging this to `.learnings/ERRORS.md` if it is non-trivial or likely to recur.",
            "Recent error signals:",
            ...pending.map((entry, index) => `${index + 1}. [${entry.toolName}] ${entry.summary}`),
            "</error-detected>",
          ].join("\n"));
        }
      }
      if (blocks.length > 0) return { prependContext: blocks.join("\n\n") };
    }, { priority: 15 });

    api.on("session_end", (_event: any, ctx: any) => {
      const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
      if (sessionKey) state.clearSession(sessionKey);
      state.prune();
    }, { priority: 20 });

    const runReflection = createReflectionCommandOrchestrator(
      {
        messageCount,
        maxInputChars,
        timeoutMs,
        thinkLevel,
        configuredAgentId,
        errorReminderMaxEntries: errorMaxEntries,
        storeToLanceDB: reflectionConfig?.storeToLanceDB !== false,
        writeLegacyCombined: reflectionConfig?.writeLegacyCombined !== false,
        selfImprovementEnabled: config.selfImprovement?.enabled === true,
      },
      {
        logger: api.logger,
        resolveRuntimeAccess: (event, context) => {
          const { agentId, access } = params.resolveRuntimeAccess(event, context);
          return { sourceAgentId: agentId, access };
        },
        resolveWorkspaceDir: params.resolveWorkspaceDir,
        resolveSessionSearchDirs: resolveReflectionSessionSearchDirs,
        resolveTargetScope: (sourceAgentId, access) => access.defaultScope ?? (isSystemBypassId(sourceAgentId)
          ? config.scopes?.default ?? "global"
          : scopeManager.getDefaultScope(sourceAgentId)),
        getToolErrorSignals: (sessionKey, maxEntries) => state.errorEntries(sessionKey, maxEntries),
        generateReflectionText: createReflectionTextGenerator({ diagnosticErrorSummary, diagnosticIdentifier }),
        appendSelfImprovementEntry,
        createReflectionEventId,
        embedPassage: (text) => embedder.embedPassage(text),
        vectorSearch: (vector, limit, minScore, scopeFilter) => store.vectorSearch(vector, limit, minScore, scopeFilter),
        storeMemory: (entry) => store.store(entry),
        mirrorMemory: params.mdMirror ?? undefined,
        storeReflection: (input) => storeReflectionToLanceDB({
          ...input,
          embedPassage: (text) => embedder.embedPassage(text),
          vectorSearch: (vector, limit, minScore, scopeFilter) => store.vectorSearch(vector, limit, minScore, scopeFilter),
          store: (entry) => store.store(entry),
        }),
        updateDerivedSession: (sessionKey, runAt, derived) => state.setDerived(sessionKey, derived, runAt),
        clearDerivedSession: (sessionKey) => state.setDerived(sessionKey, []),
        invalidateAgentReflectionCache: (agentId) => state.invalidateAgent(agentId),
        clearReflectionErrorState: (sessionKey) => state.clearSession(sessionKey),
        pruneReflectionState: () => state.prune(),
        diagnosticErrorSummary,
        diagnosticIdentifier,
      },
    );
    api.registerHook("command:new", runReflection, {
      name: "clawlore.memory-reflection.command-new",
      description: "Generate reflection log before /new",
    });
    api.registerHook("command:reset", runReflection, {
      name: "clawlore.memory-reflection.command-reset",
      description: "Generate reflection log before /reset",
    });
    params.logRegistration("memory-reflection: integrated hooks registered (command:new, command:reset, after_tool_call, before_prompt_build, session_end)");
  }

  if (config.sessionStrategy === "systemSessionMemory") {
    const messageCount = config.sessionMemory?.messageCount ?? 15;
    const guardSymbol = Symbol.for("openclaw.clawlore.session-summary-guard");
    const guardTtlMs = 24 * 60 * 60 * 1000;
    const getGuard = (): Map<string, number> => {
      const globalRecord = globalThis as Record<symbol, unknown>;
      if (!globalRecord[guardSymbol]) globalRecord[guardSymbol] = new Map<string, number>();
      return globalRecord[guardSymbol] as Map<string, number>;
    };
    const pruneGuard = (now: number) => {
      for (const [key, storedAt] of getGuard()) {
        if (now - storedAt > guardTtlMs) getGuard().delete(key);
      }
    };
    const storeSummary = async (input: {
      agentId: string;
      defaultScope: string;
      sessionKey: string;
      sessionId: string;
      source: string;
      sessionContent: string;
      timestampMs?: number;
    }) => {
      const now = new Date(input.timestampMs ?? Date.now());
      const date = now.toISOString().split("T")[0];
      const time = now.toISOString().split("T")[1].split(".")[0];
      const text = [
        `Session: ${date} ${time} UTC`,
        `Session Key: ${input.sessionKey}`,
        `Session ID: ${input.sessionId}`,
        `Source: ${input.source}`,
        "",
        "Conversation Summary:",
        input.sessionContent,
      ].join("\n");
      const safety = evaluateCaptureSafety(text);
      if (!safety.allowed) {
        api.logger.debug(`clawlore: skipped unsafe system session summary reason=${safety.reason} pattern=${safety.pattern ?? "unknown"}`);
        return;
      }
      await store.store({
        text,
        vector: await embedder.embedPassage(text),
        category: "fact",
        scope: input.defaultScope,
        importance: 0.5,
        metadata: stringifySmartMetadata(buildSmartMetadata(
          { text: `Session summary for ${date}`, category: "fact", importance: 0.5, timestamp: Date.now() },
          {
            l0_abstract: `Session summary for ${date}`,
            l1_overview: `- Session summary saved for ${input.sessionId}`,
            l2_content: text,
            memory_category: "patterns",
            tier: "peripheral",
            confidence: 0.5,
            type: "session-summary",
            sessionKey: input.sessionKey,
            sessionId: input.sessionId,
            date,
            agentId: input.agentId,
            scope: input.defaultScope,
          },
        )),
      });
      api.logger.info(`session-memory: stored session summary session=${diagnosticIdentifier(input.sessionId)} (agent=${diagnosticIdentifier(input.agentId)}, scope=${diagnosticIdentifier(input.defaultScope)})`);
    };

    api.on("before_reset", async (event, ctx) => {
      if (event.reason !== "new") return;
      try {
        const { agentId, access } = params.resolveRuntimeAccess(event, ctx);
        if (access.denied) return;
        const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
        const defaultScope = access.defaultScope ?? (isSystemBypassId(agentId)
          ? config.scopes?.default ?? "global"
          : scopeManager.getDefaultScope(agentId));
        const sessionId = typeof ctx.sessionId === "string" && ctx.sessionId.trim() ? ctx.sessionId : "unknown";
        const content = summarizeRecentConversationMessages(event.messages ?? [], messageCount)
          ?? (typeof event.sessionFile === "string"
            ? await readSessionConversationWithResetFallback(event.sessionFile, messageCount)
            : null);
        if (!content) {
          api.logger.debug("session-memory: no session content found, skipping");
          return;
        }
        const now = Date.now();
        pruneGuard(now);
        const guardKey = `${sessionKey}::${sessionId}`;
        if (getGuard().has(guardKey)) return;
        await storeSummary({
          agentId,
          defaultScope,
          sessionKey,
          sessionId,
          source: resolveSourceFromSessionKey(sessionKey),
          sessionContent: content,
        });
        getGuard().set(guardKey, now);
      } catch (error) {
        api.logger.warn(`session-memory: failed to save: ${diagnosticErrorSummary(error)}`);
      }
    });
    params.logRegistration("session-memory: typed before_reset hook registered for /new session summaries");
  } else if (config.sessionStrategy === "none") {
    params.logRegistration("session-strategy: using none (plugin memory-reflection hooks disabled)");
  }
}
