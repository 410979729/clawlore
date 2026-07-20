import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ReflectionErrorSignal,
  ReflectionGenerationResult,
  ReflectionThinkLevel,
} from "./reflection-contracts.js";
import { buildReflectionMappedMetadata } from "./reflection-mapped-metadata.js";
import {
  extractInjectableReflectionMappedMemoryItems,
  extractReflectionLearningGovernanceCandidates,
} from "./reflection-slices.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import {
  findPreviousReflectionSessionFile,
  readSessionConversationWithResetFallback,
  redactReflectionText,
  sanitizeReflectionFileToken,
} from "./reflection-transcript.js";

type ReflectionLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other" | "reflection";

interface MemoryEntryInput {
  text: string;
  vector: number[];
  category: MemoryCategory;
  scope: string;
  importance: number;
  metadata?: string;
}

interface ReflectionMemoryAccess {
  denied: boolean;
  defaultScope?: string;
  scopeFilter?: string[];
}

interface StoreReflectionResult {
  slices: { derived: string[] };
}

interface StoreReflectionParams {
  reflectionText: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  command: string;
  scope: string;
  toolErrorSignals: ReflectionErrorSignal[];
  runAt: number;
  usedFallback: boolean;
  eventId: string;
  sourceReflectionPath: string;
  writeLegacyCombined: boolean;
  embedPassage(text: string): Promise<number[]>;
  vectorSearch(
    vector: number[],
    limit?: number,
    minScore?: number,
    scopeFilter?: string[],
  ): Promise<Array<{ score: number }>>;
  store(entry: MemoryEntryInput): Promise<{ timestamp: number }>;
}

interface AppendLearningParams {
  baseDir: string;
  type: "learning";
  summary: string;
  details?: string;
  suggestedAction?: string;
  category?: string;
  area?: string;
  priority?: string;
  status?: string;
  source?: string;
}

export interface ReflectionCommandOptions {
  messageCount: number;
  maxInputChars: number;
  timeoutMs: number;
  thinkLevel: ReflectionThinkLevel;
  configuredAgentId?: string;
  errorReminderMaxEntries: number;
  storeToLanceDB: boolean;
  writeLegacyCombined: boolean;
  selfImprovementEnabled: boolean;
}

export interface ReflectionCommandDependencies {
  logger: ReflectionLogger;
  resolveRuntimeAccess(
    event: unknown,
    context: Record<string, unknown>,
  ): { sourceAgentId: string; access: ReflectionMemoryAccess };
  resolveWorkspaceDir(context: Record<string, unknown>): string;
  resolveSessionSearchDirs(params: {
    context: Record<string, unknown>;
    cfg: unknown;
    workspaceDir: string;
    currentSessionFile?: string;
    sourceAgentId?: string;
  }): string[];
  resolveTargetScope(sourceAgentId: string, access: ReflectionMemoryAccess): string;
  getToolErrorSignals(sessionKey: string, maxEntries: number): ReflectionErrorSignal[];
  generateReflectionText(params: {
    conversation: string;
    maxInputChars: number;
    cfg: unknown;
    agentId: string;
    workspaceDir: string;
    timeoutMs: number;
    thinkLevel: ReflectionThinkLevel;
    toolErrorSignals: ReflectionErrorSignal[];
    logger: ReflectionLogger;
  }): Promise<ReflectionGenerationResult>;
  appendSelfImprovementEntry(params: AppendLearningParams): Promise<unknown>;
  enforcePrivateFile(path: string): void;
  appendPrivateFile(path: string, contents: string): Promise<void>;
  createReflectionEventId(params: {
    runAt: number;
    sessionKey: string;
    sessionId: string;
    agentId: string;
    command: string;
  }): string;
  embedPassage(text: string): Promise<number[]>;
  vectorSearch(
    vector: number[],
    limit?: number,
    minScore?: number,
    scopeFilter?: string[],
  ): Promise<Array<{ score: number }>>;
  storeMemory(entry: MemoryEntryInput): Promise<{ timestamp: number }>;
  mirrorMemory?: (
    entry: { text: string; category: string; scope: string; timestamp?: number },
    metadata?: { source?: string; agentId?: string },
  ) => Promise<void>;
  storeReflection(params: StoreReflectionParams): Promise<StoreReflectionResult>;
  updateDerivedSession(sessionKey: string, runAt: number, derived: string[]): void;
  clearDerivedSession(sessionKey: string): void;
  invalidateAgentReflectionCache(agentId: string): void;
  clearReflectionErrorState(sessionKey: string): void;
  pruneReflectionState(): void;
  diagnosticErrorSummary(error: unknown): string;
  diagnosticIdentifier(value: unknown): string;
  random?: () => number;
}

function isAgentDeclaredInConfig(cfg: unknown, agentId: string): boolean {
  const target = agentId.trim();
  if (!target) return false;
  try {
    const root = cfg as Record<string, unknown>;
    const agents = root.agents as Record<string, unknown> | undefined;
    const list = agents?.list;
    return Array.isArray(list) && list.some(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        (candidate as Record<string, unknown>).id === target,
    );
  } catch {
    return false;
  }
}

async function ensureDailyLogFile(
  dailyPath: string,
  dateStr: string,
  enforcePrivateFile: (path: string) => void,
): Promise<void> {
  try {
    enforcePrivateFile(dailyPath);
    return;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(dailyPath, `# ${dateStr}\n\n`, {
    encoding: "utf-8", flag: "wx", mode: 0o600,
  });
  enforcePrivateFile(dailyPath);
}

/**
 * Builds the command:new/reset reflection use case around explicit host, store,
 * and filesystem ports. The OpenClaw entry point owns registration only.
 */
export function createReflectionCommandOrchestrator(
  options: ReflectionCommandOptions,
  dependencies: ReflectionCommandDependencies,
) {
  const warnedInvalidAgentIds = new Set<string>();
  const random = dependencies.random ?? Math.random;

  const resolveRunAgentId = (cfg: unknown, sourceAgentId: string): string => {
    if (!options.configuredAgentId) return sourceAgentId;
    if (isAgentDeclaredInConfig(cfg, options.configuredAgentId)) return options.configuredAgentId;
    if (!warnedInvalidAgentIds.has(options.configuredAgentId)) {
      dependencies.logger.warn(
        `memory-reflection: memoryReflection.agentId "${options.configuredAgentId}" not found in cfg.agents.list; ` +
        `fallback to runtime agent "${sourceAgentId}".`,
      );
      warnedInvalidAgentIds.add(options.configuredAgentId);
    }
    return sourceAgentId;
  };

  return async function runMemoryReflection(event: any): Promise<void> {
    const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";
    try {
      const context = (event.context || {}) as Record<string, unknown>;
      const { sourceAgentId, access } = dependencies.resolveRuntimeAccess(event, context);
      if (access.denied) return;
      dependencies.pruneReflectionState();

      const action = String(event?.action || "unknown");
      const cfg = context.cfg;
      const workspaceDir = dependencies.resolveWorkspaceDir(context);
      if (!cfg) {
        dependencies.logger.warn(
          `memory-reflection: command:${action} missing cfg in hook context; skip reflection`,
        );
        return;
      }

      const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
      const currentSessionId = typeof sessionEntry.sessionId === "string"
        ? sessionEntry.sessionId
        : "unknown";
      let currentSessionFile = typeof sessionEntry.sessionFile === "string"
        ? sessionEntry.sessionFile
        : undefined;
      const commandSource = typeof context.commandSource === "string" ? context.commandSource : "";
      dependencies.logger.info(
        `memory-reflection: command:${action} hook start; ` +
        `session=${dependencies.diagnosticIdentifier(sessionKey)}; ` +
        `source=${dependencies.diagnosticIdentifier(commandSource)}; ` +
        `sessionId=${dependencies.diagnosticIdentifier(currentSessionId)}; ` +
        `sessionFile=${dependencies.diagnosticIdentifier(currentSessionFile)}`,
      );

      if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
        const searchDirs = dependencies.resolveSessionSearchDirs({
          context,
          cfg,
          workspaceDir,
          currentSessionFile,
          sourceAgentId,
        });
        dependencies.logger.info(
          `memory-reflection: command:${action} session recovery start ` +
          `session=${dependencies.diagnosticIdentifier(currentSessionId)}; ` +
          `initial=${dependencies.diagnosticIdentifier(currentSessionFile)}; dirCount=${searchDirs.length}`,
        );
        for (const sessionsDir of searchDirs) {
          const recovered = await findPreviousReflectionSessionFile(
            sessionsDir,
            currentSessionFile,
            currentSessionId,
          );
          if (recovered) {
            dependencies.logger.info(
              `memory-reflection: command:${action} recovered session file ${recovered} from ${sessionsDir}`,
            );
            currentSessionFile = recovered;
            break;
          }
        }
      }

      if (!currentSessionFile) {
        const searchDirs = dependencies.resolveSessionSearchDirs({
          context,
          cfg,
          workspaceDir,
          currentSessionFile,
          sourceAgentId,
        });
        dependencies.logger.warn(
          `memory-reflection: command:${action} missing session file after recovery ` +
          `session=${dependencies.diagnosticIdentifier(currentSessionId)}; dirCount=${searchDirs.length}`,
        );
        return;
      }

      const conversation = await readSessionConversationWithResetFallback(
        currentSessionFile,
        options.messageCount,
      );
      if (!conversation) {
        dependencies.logger.warn(
          `memory-reflection: command:${action} conversation empty/unusable ` +
          `session=${dependencies.diagnosticIdentifier(currentSessionId)}; ` +
          `file=${dependencies.diagnosticIdentifier(currentSessionFile)}`,
        );
        return;
      }

      const now = new Date(typeof event.timestamp === "number" ? event.timestamp : Date.now());
      const nowTs = now.getTime();
      const dateStr = now.toISOString().split("T")[0];
      const timeIso = now.toISOString().split("T")[1].replace("Z", "");
      const timeHms = timeIso.split(".")[0];
      const timeCompact = timeIso.replace(/[:.]/g, "");
      const runAgentId = resolveRunAgentId(cfg, sourceAgentId);
      const targetScope = dependencies.resolveTargetScope(sourceAgentId, access);
      const toolErrorSignals = sessionKey
        ? dependencies.getToolErrorSignals(sessionKey, options.errorReminderMaxEntries)
        : [];

      dependencies.logger.info(
        `memory-reflection: command:${action} reflection generation start ` +
        `session=${dependencies.diagnosticIdentifier(currentSessionId)}; timeoutMs=${options.timeoutMs}`,
      );
      const generated = await dependencies.generateReflectionText({
        conversation,
        maxInputChars: options.maxInputChars,
        cfg,
        agentId: runAgentId,
        workspaceDir,
        timeoutMs: options.timeoutMs,
        thinkLevel: options.thinkLevel,
        toolErrorSignals,
        logger: dependencies.logger,
      });
      dependencies.logger.info(
        `memory-reflection: command:${action} reflection generation done ` +
        `session=${dependencies.diagnosticIdentifier(currentSessionId)}; runner=${generated.runner}; ` +
        `usedFallback=${generated.usedFallback ? "yes" : "no"}`,
      );
      if (generated.runner === "cli") {
        dependencies.logger.warn(
          `memory-reflection: embedded runner unavailable, used openclaw CLI fallback for ` +
          `session=${dependencies.diagnosticIdentifier(currentSessionId)}` +
          (generated.error ? ` (${dependencies.diagnosticErrorSummary(generated.error)})` : ""),
        );
      } else if (generated.usedFallback) {
        dependencies.logger.warn(
          `memory-reflection: fallback used for session=${dependencies.diagnosticIdentifier(currentSessionId)}` +
          (generated.error ? ` (${dependencies.diagnosticErrorSummary(generated.error)})` : ""),
        );
      }

      const reflectionText = redactReflectionText(generated.text);
      const header = [
        `# Reflection: ${dateStr} ${timeHms} UTC`,
        "",
        `- Session Key: ${sessionKey}`,
        `- Session ID: ${currentSessionId || "unknown"}`,
        `- Command: ${action}`,
        `- Error Signatures: ${toolErrorSignals.length
          ? toolErrorSignals.map((signal) => signal.signatureHash).join(", ")
          : "(none)"}`,
        "",
      ].join("\n");
      const reflectionBody = `${header}${reflectionText.trim()}\n`;

      const outDir = join(workspaceDir, "memory", "reflections", dateStr);
      await mkdir(outDir, { recursive: true, mode: 0o700 });
      const agentToken = sanitizeReflectionFileToken(sourceAgentId, "agent");
      const sessionToken = sanitizeReflectionFileToken(currentSessionId || "unknown", "session");
      let relPath = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        const suffix = attempt === 0 ? "" : `-${random().toString(36).slice(2, 8)}`;
        const fileName = `${timeCompact}-${agentToken}-${sessionToken}${suffix}.md`;
        const candidateRelPath = join("memory", "reflections", dateStr, fileName);
        try {
          await writeFile(join(workspaceDir, candidateRelPath), reflectionBody, {
            encoding: "utf-8",
            flag: "wx",
            mode: 0o600,
          });
          dependencies.enforcePrivateFile(join(workspaceDir, candidateRelPath));
          relPath = candidateRelPath;
          break;
        } catch (error: any) {
          if (error?.code === "EEXIST") continue;
          throw error;
        }
      }
      if (!relPath) {
        throw new Error(`Failed to allocate unique reflection file for ${dateStr} ${timeCompact}`);
      }

      if (options.selfImprovementEnabled) {
        for (const candidate of extractReflectionLearningGovernanceCandidates(reflectionText)) {
          await dependencies.appendSelfImprovementEntry({
            baseDir: workspaceDir,
            type: "learning",
            summary: candidate.summary,
            details: candidate.details,
            suggestedAction: candidate.suggestedAction,
            category: "best_practice",
            area: candidate.area || "config",
            priority: candidate.priority || "medium",
            status: candidate.status || "pending",
            source: `clawlore/reflection:${relPath}`,
          });
        }
      }

      const eventId = dependencies.createReflectionEventId({
        runAt: nowTs,
        sessionKey,
        sessionId: currentSessionId || "unknown",
        agentId: sourceAgentId,
        command: action,
      });

      for (const mapped of extractInjectableReflectionMappedMemoryItems(reflectionText)) {
        const safety = evaluateCaptureSafety(mapped.text);
        if (!safety.allowed) {
          dependencies.logger.debug(
            `memory-reflection: skipped unsafe mapped memory reason=${safety.reason} ` +
            `pattern=${safety.pattern ?? "unknown"}`,
          );
          continue;
        }
        const mappedText = sanitizeCaptureText(mapped.text);
        if (!mappedText) continue;

        const vector = await dependencies.embedPassage(mappedText);
        let existing: Array<{ score: number }> = [];
        try {
          existing = await dependencies.vectorSearch(vector, 1, 0.1, [targetScope]);
        } catch (error) {
          dependencies.logger.warn(
            `memory-reflection: mapped memory duplicate pre-check failed, continue store: ` +
            dependencies.diagnosticErrorSummary(error),
          );
        }
        if (existing.length > 0 && existing[0].score > 0.95) continue;

        const storedEntry = await dependencies.storeMemory({
          text: mappedText,
          vector,
          importance: mapped.category === "decision" ? 0.85 : 0.8,
          category: mapped.category,
          scope: targetScope,
          metadata: JSON.stringify(buildReflectionMappedMetadata({
            mappedItem: mapped,
            eventId,
            agentId: sourceAgentId,
            sessionKey,
            sessionId: currentSessionId || "unknown",
            runAt: nowTs,
            usedFallback: generated.usedFallback,
            toolErrorSignals,
            sourceReflectionPath: relPath,
          })),
        });

        await dependencies.mirrorMemory?.(
          {
            text: mapped.text,
            category: mapped.category,
            scope: targetScope,
            timestamp: storedEntry.timestamp,
          },
          { source: `reflection:${mapped.heading}`, agentId: sourceAgentId },
        );
      }

      if (options.storeToLanceDB) {
        const stored = await dependencies.storeReflection({
          reflectionText,
          sessionKey,
          sessionId: currentSessionId || "unknown",
          agentId: sourceAgentId,
          command: action,
          scope: targetScope,
          toolErrorSignals,
          runAt: nowTs,
          usedFallback: generated.usedFallback,
          eventId,
          sourceReflectionPath: relPath,
          writeLegacyCombined: options.writeLegacyCombined,
          embedPassage: dependencies.embedPassage,
          vectorSearch: dependencies.vectorSearch,
          store: dependencies.storeMemory,
        });
        if (sessionKey && stored.slices.derived.length > 0) {
          dependencies.updateDerivedSession(sessionKey, nowTs, stored.slices.derived);
        }
        dependencies.invalidateAgentReflectionCache(sourceAgentId);
      } else if (sessionKey && generated.usedFallback) {
        dependencies.clearDerivedSession(sessionKey);
      }

      const dailyPath = join(workspaceDir, "memory", `${dateStr}.md`);
      await ensureDailyLogFile(dailyPath, dateStr, dependencies.enforcePrivateFile);
      await dependencies.appendPrivateFile(
        dailyPath,
        `- [${timeHms} UTC] Reflection generated: \`${relPath}\`\n`,
      );
      dependencies.logger.info(
        `memory-reflection: wrote file=${dependencies.diagnosticIdentifier(relPath)} ` +
        `for session=${dependencies.diagnosticIdentifier(currentSessionId)}`,
      );
    } catch (error) {
      dependencies.logger.warn(
        `memory-reflection: hook failed: ${dependencies.diagnosticErrorSummary(error)}`,
      );
    } finally {
      if (sessionKey) dependencies.clearReflectionErrorState(sessionKey);
      dependencies.pruneReflectionState();
    }
  };
}
