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
    const mode = raw.mode === "shadow" ? "shadow" : "disabled";
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
    };
}
function validApproval(approval, readiness) {
    if (!approval || !readiness)
        return false;
    return approval.schemaVersion === 1
        && approval.decision === "approved"
        && approval.mode === "shadow"
        && typeof approval.actor === "string"
        && Boolean(approval.actor.trim())
        && typeof approval.rolloutId === "string"
        && approval.rolloutId === readiness.rollout.rolloutId
        && typeof approval.approvedAt === "string"
        && Number.isFinite(Date.parse(approval.approvedAt));
}
async function observeWithoutBlockingReply(input) {
    let timer;
    const operation = input.operation
        .then(() => "completed")
        .catch(() => {
        input.onError?.("shadow_observer_failed");
        return "failed";
    });
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), input.maxLatencyMs);
    });
    const outcome = await Promise.race([operation, timeout]);
    if (timer)
        clearTimeout(timer);
    if (outcome === "timeout")
        input.onError?.("shadow_observer_timeout");
}
function activationBlocks(input) {
    if (input.config.mode === "disabled")
        return [];
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
        if (!readiness.rollout.requiresOperatorApproval)
            blocks.push("approval_contract_missing");
    }
    if (!validApproval(input.approval, readiness))
        blocks.push("operator_approval_missing_or_invalid");
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
    input.host.on("before_prompt_build", async (event, context) => {
        sequence += 1;
        await observeWithoutBlockingReply({
            maxLatencyMs: input.config.maxLatencyMs,
            onError: input.dependencies.onObserverError,
            operation: runDefaultOffRuntimeShadow({
                config: { enabled: true },
                sink,
                now: input.dependencies.now,
                input: {
                    traceId: opaqueTraceId(sequence, event, context),
                    availableTokens: numericBudget(event, context, input.config.tokenBudget),
                    identity: {
                        tenantId: input.dependencies.tenantId,
                        agentId: typeof context.agentId === "string" && context.agentId.trim()
                            ? context.agentId.trim()
                            : input.dependencies.agentId,
                        workspaceId: input.dependencies.workspaceId,
                        runtimeContext: context,
                        event,
                    },
                    retrieveCandidates: input.dependencies.retrieveCandidates,
                },
            }),
        });
        return undefined;
    }, { priority: -100 });
    return { ...base, status: "registered", registeredHooks: ["before_prompt_build"] };
}
export class InMemoryRuntimeShadowSinkV1 {
    receipts = [];
    async append(receipt) {
        this.receipts.push(structuredClone(receipt));
    }
}
