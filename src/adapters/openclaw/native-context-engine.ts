import { createHash } from "node:crypto";

import {
  composeContextPack,
  renderCompatibilityContextPack,
  type ContextCandidateV1,
} from "../../application/context-composer.js";
import { resolveContextEngineActorAddressV1 } from "../../application/context-engine-session-identity.js";
import type { MemoryAddressV2 } from "../../v2/domain/memory-address.js";
import type { CompatibilityRetrievalRequestV1 } from "./compatibility-context-adapter.js";

type OpenClawCompactionDelegate = typeof import(
  "openclaw/plugin-sdk/core"
).delegateCompactionToRuntime;
type OpenClawCompactionInput = Parameters<OpenClawCompactionDelegate>[0];
type OpenClawCompactionResult = Awaited<ReturnType<OpenClawCompactionDelegate>>;

export interface NativeContextEngineMessageV1 {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface NativeContextEngineV1 {
  readonly info: {
    id: "clawlore";
    name: "ClawLore V2";
    version: string;
    ownsCompaction: false;
  };
  ingest(input: {
    sessionId: string;
    sessionKey?: string;
    message: NativeContextEngineMessageV1;
  }): Promise<{ ingested: false }>;
  assemble(input: {
    sessionId: string;
    sessionKey?: string;
    messages: NativeContextEngineMessageV1[];
    tokenBudget?: number;
    prompt?: string;
  }): Promise<{
    messages: NativeContextEngineMessageV1[];
    estimatedTokens: number;
    promptAuthority: "preassembly_may_overflow";
    systemPromptAddition?: string;
  }>;
  compact(input: OpenClawCompactionInput): Promise<OpenClawCompactionResult>;
}

export interface NativeContextEngineDependenciesV1 {
  version: string;
  tenantId: string;
  agentId: string;
  workspaceId?: string;
  tokenBudget: number;
  maxQueryChars: number;
  retrieveCandidates(request: CompatibilityRetrievalRequestV1): Promise<ContextCandidateV1[]>;
  compactionDelegate?: OpenClawCompactionDelegate;
}

async function delegateCompaction(input: OpenClawCompactionInput): Promise<OpenClawCompactionResult> {
  const { delegateCompactionToRuntime } = await import("openclaw/plugin-sdk/core");
  return delegateCompactionToRuntime(input);
}

function estimatedTokens(messages: NativeContextEngineMessageV1[], addition = ""): number {
  const serialized = messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    try {
      return JSON.stringify(message.content ?? "");
    } catch {
      return "";
    }
  }).join("\n");
  return Math.max(1, Math.ceil((serialized.length + addition.length) / 4));
}

function actorAddress(input: {
  tenantId: string;
  agentId: string;
  workspaceId?: string;
  sessionKey?: string;
}): MemoryAddressV2 | undefined {
  return resolveContextEngineActorAddressV1({
    tenantId: input.tenantId,
    configuredAgentId: input.agentId,
    workspaceId: input.workspaceId,
    sessionKey: input.sessionKey,
  });
}

function traceId(sessionId: string, query: string): string {
  return `clawlore-cutover-${createHash("sha256")
    .update(`${sessionId}\u0000${query}`)
    .digest("hex")
    .slice(0, 20)}`;
}

export function createClawLoreNativeContextEngineV1(
  dependencies: NativeContextEngineDependenciesV1,
): NativeContextEngineV1 {
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
        availableTokens: Math.max(
          32,
          Math.min(dependencies.tokenBudget, input.tokenBudget ?? dependencies.tokenBudget),
        ),
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
