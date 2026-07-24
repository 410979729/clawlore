import { createHash } from "node:crypto";
import { negotiateContextEngineV2, } from "./context-engine-skeleton.js";
import { JsonlRuntimeShadowTraceSink, runDefaultOffRuntimeShadow, } from "./runtime-shadow.js";
function record(value) {
    return value && typeof value === "object" ? value : {};
}
function boundedInteger(value, fallback, minimum, maximum) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
export function normalizeClawLoreRuntimeConfigV1(value) {
    const raw = record(value);
    const mode = ["shadow", "v2-write", "cutover"].includes(String(raw.mode))
        ? raw.mode
        : "disabled";
    const contextEngine = raw.contextEngine === "native-opt-in"
        ? "native-opt-in"
        : "compatibility";
    return {
        mode,
        contextEngine,
        tokenBudget: boundedInteger(raw.tokenBudget, 512, 32, 32_768),
        maxLatencyMs: boundedInteger(raw.maxLatencyMs, 750, 25, 5_000),
        traceFile: typeof raw.traceFile === "string" && raw.traceFile.trim()
            ? raw.traceFile.trim()
            : undefined,
        maxTraceBytes: boundedInteger(raw.maxTraceBytes, 5_000_000, 16_384, 100_000_000),
        maxQueryChars: boundedInteger(raw.maxQueryChars, 4_000, 256, 12_000),
        candidateLimit: boundedInteger(raw.candidateLimit, 6, 1, 20),
        maxConcurrent: boundedInteger(raw.maxConcurrent, 2, 1, 16),
    };
}
function shadowQueryText(event, context, maxChars) {
    const candidates = [
        event.bodyForAgent,
        event.body,
        event.content,
        event.userPrompt,
        event.prompt,
        event.text,
        event.content,
        context.userPrompt,
        context.prompt,
    ];
    const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
    return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}
function shadowChatType(event, context) {
    if (event.isGroup === true)
        return "group";
    if (event.isGroup === false)
        return "direct";
    const sessionKey = [context.sessionKey, event.sessionKey]
        .find((value) => typeof value === "string" && value.trim());
    if (typeof sessionKey === "string") {
        const match = sessionKey.match(/:(direct|group|channel):/i);
        if (match?.[1])
            return match[1].toLowerCase();
    }
    const metadata = record(event.metadata);
    if (metadata.guildId || metadata.groupId || metadata.channelName)
        return "group";
    return undefined;
}
function shadowVisibility(chatType) {
    // Unknown ingress types fail toward conversation scope so a group message
    // can never be treated as a private-memory request.
    return chatType === "direct" ? "private" : "conversation";
}
async function observeWithoutBlockingReply(input) {
    let timer;
    const operation = input.operation
        .then(() => "completed")
        .catch(() => {
        if (!input.controller.signal.aborted)
            input.onError?.("shadow_observer_failed");
        return input.controller.signal.aborted ? "aborted" : "failed";
    });
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            input.controller.abort("shadow_observer_timeout");
            resolve("timeout");
        }, input.maxLatencyMs);
    });
    const outcome = await Promise.race([operation, timeout]);
    if (timer)
        clearTimeout(timer);
    if (outcome === "timeout")
        input.onError?.("shadow_observer_timeout");
    return outcome;
}
function observerKey(event, context) {
    const material = [
        context.sessionKey,
        context.sessionId,
        context.conversationId,
        event.senderId,
        context.senderId,
    ].map((value) => String(value ?? "")).join("\u0000");
    return createHash("sha256").update(material).digest("hex");
}
function activationBlocks(input) {
    if (input.config.mode === "disabled")
        return [];
    if (input.config.mode !== "shadow")
        return ["native_runtime_requires_registration_adapter"];
    const blocks = [];
    const readiness = input.readiness;
    if (!readiness) {
        blocks.push("release_readiness_missing");
    }
    else {
        if (readiness.status !== "ready" || !readiness.rollout.ready)
            blocks.push("release_readiness_blocked");
        if (readiness.rollout.requestedMode !== "shadow")
            blocks.push("readiness_mode_mismatch");
        if (!readiness.rollout.readOnly)
            blocks.push("readiness_not_read_only");
    }
    if (input.config.contextEngine !== "compatibility")
        blocks.push("native_context_engine_not_enabled_in_this_slice");
    return [...new Set(blocks)].sort();
}
function numericBudget(event, context, fallback) {
    const candidates = [
        context.availableTokens,
        context.tokenBudget,
        record(context.budget).availableTokens,
        event.availableTokens,
        event.tokenBudget,
        record(event.budget).availableTokens,
    ];
    const value = candidates.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
    return boundedInteger(value, fallback, 32, 32_768);
}
function opaqueTraceId(sequence, event, context) {
    const material = [
        event.runId,
        event.sessionKey,
        context.runId,
        context.sessionId,
        context.sessionKey,
        event.id,
        event.messageId,
        sequence,
    ].map((value) => String(value ?? "")).join("\u0000");
    return `clawlore-shadow-${createHash("sha256").update(material).digest("hex").slice(0, 20)}`;
}
export function composeClawLoreRuntimeV1(input) {
    const contextEngine = negotiateContextEngineV2({
        requested: input.config.contextEngine,
        host: input.host.capabilities ?? {},
    });
    const blockingReasons = activationBlocks(input);
    const base = {
        schemaVersion: 1,
        requestedMode: input.config.mode,
        toolRegistrations: 0,
        writeEnabled: false,
        promptMutationEnabled: false,
        contextEngineRegistered: false,
        contextEngine,
        blockingReasons,
    };
    if (input.config.mode === "disabled") {
        return { ...base, status: "disabled", registeredHooks: [] };
    }
    if (blockingReasons.length > 0) {
        return { ...base, status: "blocked", registeredHooks: [] };
    }
    const sink = input.dependencies.traceSink
        ?? (input.config.traceFile
            ? new JsonlRuntimeShadowTraceSink(input.config.traceFile, input.config.maxTraceBytes)
            : undefined);
    let sequence = 0;
    const activeObservers = new Set();
    let lateObservers = 0;
    let observerTimeouts = 0;
    let observerSaturations = 0;
    const emitObserverMetrics = () => input.dependencies.onObserverMetrics?.({
        active: activeObservers.size,
        late: lateObservers,
        timeouts: observerTimeouts,
        saturated: observerSaturations,
    });
    input.host.on("message_received", async (event, context) => {
        sequence += 1;
        const metadata = record(event.metadata);
        const chatType = shadowChatType(event, context);
        const key = observerKey(event, context);
        if (activeObservers.has(key)) {
            input.dependencies.onObserverError?.("shadow_observer_deduplicated");
            return;
        }
        if (activeObservers.size >= input.config.maxConcurrent) {
            observerSaturations += 1;
            input.dependencies.onObserverError?.("shadow_observer_saturated");
            emitObserverMetrics();
            return;
        }
        const controller = new AbortController();
        activeObservers.add(key);
        emitObserverMetrics();
        const operation = runDefaultOffRuntimeShadow({
            config: { enabled: true },
            sink,
            now: input.dependencies.now,
            input: {
                traceId: opaqueTraceId(sequence, event, context),
                ingressKind: chatType ?? "unknown",
                availableTokens: numericBudget(event, context, input.config.tokenBudget),
                queryText: shadowQueryText(event, context, input.config.maxQueryChars),
                signal: controller.signal,
                identity: {
                    tenantId: input.dependencies.tenantId,
                    agentId: typeof context.agentId === "string" && context.agentId.trim()
                        ? context.agentId.trim()
                        : input.dependencies.agentId,
                    workspaceId: input.dependencies.workspaceId,
                    requestedVisibility: shadowVisibility(chatType),
                    runtimeContext: context,
                    event,
                    staticContext: {
                        platform: context.channelId ?? metadata.originatingChannel
                            ?? metadata.provider ?? metadata.surface,
                        accountId: context.accountId,
                        senderId: event.senderId ?? context.senderId ?? metadata.senderId,
                        conversationId: context.conversationId ?? metadata.originatingTo,
                        threadId: event.threadId ?? metadata.threadId,
                        chatType: chatType ?? "unknown",
                    },
                },
                retrieveCandidates: input.dependencies.retrieveCandidates,
                ...(input.dependencies.retrieveComparisonCandidates
                    ? { retrieveComparisonCandidates: input.dependencies.retrieveComparisonCandidates }
                    : {}),
            },
        });
        const outcome = await observeWithoutBlockingReply({
            operation,
            controller,
            maxLatencyMs: input.config.maxLatencyMs,
            onError: input.dependencies.onObserverError,
        });
        // Release the concurrency slot when the bounded observer window ends,
        // even when a non-cooperative provider ignores AbortSignal forever.
        activeObservers.delete(key);
        if (outcome === "timeout") {
            observerTimeouts += 1;
            lateObservers += 1;
            void operation.then(() => { lateObservers = Math.max(0, lateObservers - 1); emitObserverMetrics(); }, () => { lateObservers = Math.max(0, lateObservers - 1); emitObserverMetrics(); });
        }
        emitObserverMetrics();
    }, { priority: -100 });
    return { ...base, status: "registered", registeredHooks: ["message_received"] };
}
export class InMemoryRuntimeShadowSinkV1 {
    receipts = [];
    async append(receipt) {
        this.receipts.push(structuredClone(receipt));
    }
}
