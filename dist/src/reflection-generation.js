import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runWithReflectionTransientRetryOnce } from "./reflection-retry.js";
const REFLECTION_FALLBACK_MARKER = "(fallback) Reflection generation failed; storing minimal pointer only.";
function toImportSpecifier(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("file://"))
        return trimmed;
    if (trimmed.startsWith("/"))
        return pathToFileURL(trimmed).href;
    return trimmed;
}
function getExtensionApiImportSpecifiers(extensionApiPath) {
    const requireFromHere = createRequire(import.meta.url);
    const specifiers = [];
    const configuredPath = extensionApiPath?.trim() || process.env.OPENCLAW_EXTENSION_API_PATH?.trim();
    if (configuredPath)
        specifiers.push(toImportSpecifier(configuredPath));
    specifiers.push("openclaw/dist/extensionAPI.js");
    try {
        specifiers.push(toImportSpecifier(requireFromHere.resolve("openclaw/dist/extensionAPI.js")));
    }
    catch {
        // Continue with known global installation layouts.
    }
    specifiers.push(toImportSpecifier("/usr/lib/node_modules/openclaw/dist/extensionAPI.js"));
    specifiers.push(toImportSpecifier("/usr/local/lib/node_modules/openclaw/dist/extensionAPI.js"));
    specifiers.push(toImportSpecifier("/opt/homebrew/lib/node_modules/openclaw/dist/extensionAPI.js"));
    return [...new Set(specifiers.filter(Boolean))];
}
function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function resolveAgentPrimaryModelRef(cfg, agentId) {
    try {
        const root = cfg;
        const agents = root.agents;
        const list = agents?.list;
        if (Array.isArray(list)) {
            const found = list.find((candidate) => candidate &&
                typeof candidate === "object" &&
                candidate.id === agentId);
            const model = found?.model;
            if (typeof model?.primary === "string" && model.primary.trim())
                return model.primary.trim();
        }
        const defaults = agents?.defaults;
        const defaultModel = defaults?.model;
        if (typeof defaultModel?.primary === "string" && defaultModel.primary.trim()) {
            return defaultModel.primary.trim();
        }
    }
    catch {
        // Missing model metadata lets the embedded runtime choose its configured default.
    }
    return undefined;
}
function splitProviderModel(modelRef) {
    const normalized = modelRef.trim();
    if (!normalized)
        return {};
    const separator = normalized.indexOf("/");
    if (separator <= 0)
        return { model: normalized };
    const provider = normalized.slice(0, separator).trim();
    const model = normalized.slice(separator + 1).trim();
    return { provider: provider || undefined, model: model || undefined };
}
export function buildReflectionPrompt(conversation, maxInputChars, toolErrorSignals = []) {
    const clipped = conversation.slice(-maxInputChars);
    const errorHints = toolErrorSignals.length > 0
        ? toolErrorSignals
            .map((signal, index) => `${index + 1}. [${signal.toolName}] ${signal.summary} (sig:${signal.signatureHash.slice(0, 8)})`)
            .join("\n")
        : "- (none)";
    return [
        "You are generating a durable MEMORY REFLECTION entry for an AI assistant system.",
        "",
        "Output Markdown only. No intro text. No outro text. No extra headings.",
        "",
        "Use these headings exactly once, in this exact order, with exact spelling:",
        "## Context (session background)",
        "## Decisions (durable)",
        "## User model deltas (about the human)",
        "## Agent model deltas (about the assistant/system)",
        "## Lessons & pitfalls (symptom / cause / fix / prevention)",
        "## Learning governance candidates (.learnings / promotion / skill extraction)",
        "## Open loops / next actions",
        "## Retrieval tags / keywords",
        "## Invariants",
        "## Derived",
        "",
        "Hard rules:",
        "- Do not rename, translate, merge, reorder, or omit headings.",
        "- Every section must appear exactly once.",
        "- For bullet sections, use one item per line, starting with '- '.",
        "- Do not wrap one bullet across multiple lines.",
        "- If a bullet section is empty, write exactly: '- (none captured)'",
        "- Do not paste raw transcript.",
        "- Do not invent Logged timestamps, ids, file paths, commit hashes, session ids, or storage metadata unless they already appear in the input.",
        "- If secrets/tokens/passwords appear, keep them as [REDACTED].",
        "",
        "Section rules:",
        "- Context / Decisions / User model / Agent model / Open loops / Retrieval tags / Invariants / Derived = bullet lists only.",
        "- Lessons & pitfalls = bullet list only; each bullet must be one single line in this shape:",
        "  - Symptom: ... Cause: ... Fix: ... Prevention: ...",
        "- Invariants = stable cross-session rules only; prefer bullets starting with Always / Never / When / If / Before / After / Prefer / Avoid / Require.",
        "- Derived = recent-run distilled learnings, adjustments, and follow-up heuristics that may help the next several runs, but should decay over time.",
        "- Keep Invariants stable and long-lived; keep Derived recent, reusable across near-term runs, and decayable.",
        "- Do not restate long-term rules in Derived.",
        "",
        "Governance section rules:",
        "- If empty, write exactly:",
        "  - (none captured)",
        "- Otherwise, do NOT use bullet lists there.",
        "- Use one or more entries in exactly this format:",
        "",
        "### Entry 1",
        "**Priority**: low|medium|high|critical",
        "**Status**: pending|triage|promoted_to_skill|done",
        "**Area**: frontend|backend|infra|tests|docs|config|<custom area>",
        "### Summary",
        "<one concise candidate>",
        "### Details",
        "<short supporting details>",
        "### Suggested Action",
        "<one concrete next action>",
        "",
        "Notes:",
        "- Keep writer-owned metadata out of the output. The writer generates Logged and IDs.",
        "- Prefer structured, machine-parseable output over elegant prose.",
        "",
        "OUTPUT TEMPLATE (copy this structure exactly):",
        "## Context (session background)",
        "- ...",
        "",
        "## Decisions (durable)",
        "- ...",
        "",
        "## User model deltas (about the human)",
        "- ...",
        "",
        "## Agent model deltas (about the assistant/system)",
        "- ...",
        "",
        "## Lessons & pitfalls (symptom / cause / fix / prevention)",
        "- Symptom: ... Cause: ... Fix: ... Prevention: ...",
        "",
        "## Learning governance candidates (.learnings / promotion / skill extraction)",
        "### Entry 1",
        "**Priority**: medium",
        "**Status**: pending",
        "**Area**: config",
        "### Summary",
        "...",
        "### Details",
        "...",
        "### Suggested Action",
        "...",
        "",
        "## Open loops / next actions",
        "- ...",
        "",
        "## Retrieval tags / keywords",
        "- ...",
        "",
        "## Invariants",
        "- Always ...",
        "",
        "## Derived",
        "- This run showed ...",
        "",
        "Recent tool error signals:",
        errorHints,
        "",
        "INPUT:",
        "```",
        clipped,
        "```",
    ].join("\n");
}
export function buildReflectionFallbackText() {
    return [
        "## Context (session background)",
        `- ${REFLECTION_FALLBACK_MARKER}`,
        "",
        "## Decisions (durable)",
        "- (none captured)",
        "",
        "## User model deltas (about the human)",
        "- (none captured)",
        "",
        "## Agent model deltas (about the assistant/system)",
        "- (none captured)",
        "",
        "## Lessons & pitfalls (symptom / cause / fix / prevention)",
        "- (none captured)",
        "",
        "## Learning governance candidates (.learnings / promotion / skill extraction)",
        "### Entry 1",
        "**Priority**: medium",
        "**Status**: triage",
        "**Area**: config",
        "### Summary",
        "Investigate last failed tool execution and decide whether it belongs in .learnings/ERRORS.md.",
        "### Details",
        "The reflection pipeline fell back; confirm the failure is reproducible before treating it as a durable error record.",
        "### Suggested Action",
        "Reproduce the latest failed tool execution, classify it as triage or error, and then log it with the appropriate tool/file path evidence.",
        "",
        "## Open loops / next actions",
        "- Investigate why embedded reflection generation failed.",
        "",
        "## Retrieval tags / keywords",
        "- memory-reflection",
        "",
        "## Invariants",
        "- (none captured)",
        "",
        "## Derived",
        "- Investigate why embedded reflection generation failed before trusting any next-run delta.",
    ].join("\n");
}
/** Creates one generator with a cached embedded-runtime loader and injectable test boundary. */
export function createReflectionTextGenerator(dependencies) {
    let embeddedRunnerPromise = null;
    const now = dependencies.now ?? Date.now;
    const random = dependencies.random ?? Math.random;
    const loadEmbeddedRunner = async () => {
        if (dependencies.loadEmbeddedRunner)
            return dependencies.loadEmbeddedRunner();
        if (!embeddedRunnerPromise) {
            embeddedRunnerPromise = (async () => {
                const errors = [];
                for (const specifier of getExtensionApiImportSpecifiers(dependencies.extensionApiPath)) {
                    try {
                        const module = await import(specifier);
                        const runner = module.runEmbeddedPiAgent;
                        if (typeof runner === "function")
                            return runner;
                        errors.push(`${specifier}: runEmbeddedPiAgent export not found`);
                    }
                    catch (error) {
                        errors.push(`candidate=${dependencies.diagnosticIdentifier(specifier)} ` +
                            `error=${dependencies.diagnosticErrorSummary(error)}`);
                    }
                }
                throw new Error("Unable to load OpenClaw embedded runtime API. " +
                    "Set OPENCLAW_EXTENSION_API_PATH if runtime layout differs. " +
                    `Attempts: ${errors.join(" | ")}`);
            })();
        }
        try {
            return await embeddedRunnerPromise;
        }
        catch (error) {
            embeddedRunnerPromise = null;
            throw error;
        }
    };
    return async function generateReflectionText(params) {
        const prompt = buildReflectionPrompt(params.conversation, params.maxInputChars, params.toolErrorSignals ?? []);
        const promptHash = createHash("sha256").update(prompt, "utf8").digest("hex");
        const tempSessionFile = join(tmpdir(), `memory-reflection-${now()}-${random().toString(36).slice(2)}.jsonl`);
        let reflectionText = null;
        const errors = [];
        const retryState = { count: 0 };
        try {
            const result = await runWithReflectionTransientRetryOnce({
                scope: "reflection",
                runner: "embedded",
                retryState,
                onLog: (level, message) => {
                    if (level === "warn")
                        params.logger?.warn?.(message);
                    else
                        params.logger?.info?.(message);
                },
                execute: async () => {
                    const runEmbeddedPiAgent = await loadEmbeddedRunner();
                    const modelRef = resolveAgentPrimaryModelRef(params.cfg, params.agentId);
                    const { provider, model } = modelRef ? splitProviderModel(modelRef) : {};
                    const embeddedTimeoutMs = Math.max(params.timeoutMs + 5_000, 15_000);
                    const runAt = now();
                    return withTimeout(runEmbeddedPiAgent({
                        sessionId: `reflection-${runAt}`,
                        sessionKey: "temp:memory-reflection",
                        agentId: params.agentId,
                        sessionFile: tempSessionFile,
                        workspaceDir: params.workspaceDir,
                        config: params.cfg,
                        prompt,
                        disableTools: true,
                        disableMessageTool: true,
                        timeoutMs: params.timeoutMs,
                        runId: `memory-reflection-${runAt}`,
                        bootstrapContextMode: "lightweight",
                        thinkLevel: params.thinkLevel,
                        provider,
                        model,
                    }), embeddedTimeoutMs, "embedded reflection run");
                },
            });
            const payloads = result && typeof result === "object" && Array.isArray(result.payloads)
                ? result.payloads
                : [];
            const firstWithText = payloads.find((payload) => payload &&
                typeof payload === "object" &&
                typeof payload.text === "string" &&
                payload.text.trim().length > 0);
            reflectionText = typeof firstWithText?.text === "string" ? firstWithText.text.trim() : null;
        }
        catch (error) {
            errors.push(`embedded:${dependencies.diagnosticErrorSummary(error)}`);
        }
        finally {
            await unlink(tempSessionFile).catch(() => { });
        }
        if (reflectionText) {
            return {
                text: reflectionText,
                usedFallback: false,
                promptHash,
                error: errors[0],
                runner: "embedded",
            };
        }
        return {
            text: buildReflectionFallbackText(),
            usedFallback: true,
            promptHash,
            error: errors.length > 0 ? errors.join(" | ") : undefined,
            runner: "fallback",
        };
    };
}
