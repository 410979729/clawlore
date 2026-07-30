import { createHash } from "node:crypto";
import { composeContextPack, renderCompatibilityContextPack, } from "../../application/context-composer.js";
import { resolveContextEngineActorAddressV1 } from "../../application/context-engine-session-identity.js";
async function delegateCompaction(input) {
    const { delegateCompactionToRuntime } = await import("openclaw/plugin-sdk/core");
    return delegateCompactionToRuntime(input);
}
function estimatedTokens(messages, addition = "") {
    const serialized = messages.map((message) => {
        if (typeof message.content === "string")
            return message.content;
        try {
            return JSON.stringify(message.content ?? "");
        }
        catch {
            return "";
        }
    }).join("\n");
    return Math.max(1, Math.ceil((serialized.length + addition.length) / 4));
}
function actorAddress(input) {
    return resolveContextEngineActorAddressV1({
        tenantId: input.tenantId,
        configuredAgentId: input.agentId,
        workspaceId: input.workspaceId,
        sessionKey: input.sessionKey,
    });
}
function traceId(sessionId, query) {
    return `clawlore-cutover-${createHash("sha256")
        .update(`${sessionId}\u0000${query}`)
        .digest("hex")
        .slice(0, 20)}`;
}
export function createClawLoreNativeContextEngineV1(dependencies) {
    return {
        info: {
            // OpenClaw resolves plugins.slots.contextEngine as both the plugin id
            // needed for loading and the registered engine id. Keep this equal to
            // the canonical plugin id or the host will silently fall back to legacy.
            id: "clawlore",
            name: "ClawLore V2",
            version: dependencies.version,
            ownsCompaction: false,
        },
        async ingest() {
            // Canonical memory writes remain behind ClawLore's transactional write
            // tools/capture pipeline. Transcript ingestion must not create a second,
            // unaudited writer.
            return { ingested: false };
        },
        async assemble(input) {
            const messages = [...input.messages];
            const query = String(input.prompt ?? "").trim().slice(0, dependencies.maxQueryChars);
            const actor = actorAddress({
                tenantId: dependencies.tenantId,
                agentId: dependencies.agentId,
                workspaceId: dependencies.workspaceId,
                sessionKey: input.sessionKey,
            });
            if (!actor || !query) {
                return {
                    messages,
                    estimatedTokens: estimatedTokens(messages),
                    promptAuthority: "preassembly_may_overflow",
                };
            }
            const candidates = await dependencies.retrieveCandidates({
                boundary: {
                    tenantId: actor.tenantId,
                    principalId: actor.principalId,
                    agentId: actor.agentId,
                    visibility: actor.visibility,
                    ...(actor.workspaceId ? { workspaceId: actor.workspaceId } : {}),
                    ...(actor.platform ? { platform: actor.platform } : {}),
                    ...(actor.accountId ? { accountId: actor.accountId } : {}),
                },
                queryText: query,
            });
            const pack = composeContextPack({
                traceId: traceId(input.sessionId, query),
                actorAddress: actor,
                availableTokens: Math.max(32, Math.min(dependencies.tokenBudget, input.tokenBudget ?? dependencies.tokenBudget)),
                candidates,
            });
            const addition = pack.trace.selectedCount > 0
                ? renderCompatibilityContextPack(pack)
                : undefined;
            return {
                messages,
                estimatedTokens: estimatedTokens(messages, addition),
                promptAuthority: "preassembly_may_overflow",
                ...(addition ? { systemPromptAddition: addition } : {}),
            };
        },
        async compact(input) {
            // This engine does not own the transcript compaction algorithm. It must
            // still bridge manual and overflow-triggered compaction to OpenClaw;
            // returning a successful no-op would leave an overflowing turn stuck.
            return (dependencies.compactionDelegate ?? delegateCompaction)(input);
        },
    };
}
