import type { MemoryAddressV2 } from "../domain/memory-address.js";
import type { MemoryMutationReceiptV2, MemoryRecordV2 } from "../domain/memory-record.js";
import { decideMemoryAccess, type MemoryOperation } from "./policy-decision.js";
import type { TruthStoreV2Port } from "./ports/truth-store.js";

export const CLAWLORE_AGENT_ACTIONS = [
  "memory_query",
  "memory_remember",
  "memory_correct",
  "memory_forget",
] as const;

export class AgentMemoryFacadeV2 {
  constructor(private readonly truth: TruthStoreV2Port) {}

  private requireAccessible(
    actor: MemoryAddressV2,
    itemId: string,
    operation: Extract<MemoryOperation, "correct" | "forget">,
  ): MemoryRecordV2 {
    const current = this.truth.get(itemId);
    if (!current) throw new Error("memory item is not accessible to actor");
    const decision = decideMemoryAccess({
      actor,
      target: current.address,
      operation,
      mode: "explicit",
    });
    if (!decision.allowed) throw new Error("memory item is not accessible to actor");
    return current;
  }

  query(actor: MemoryAddressV2, query: string, limit?: number): MemoryRecordV2[] {
    return this.truth.queryAccessible(actor, query, limit);
  }

  remember(input: {
    actor: MemoryAddressV2;
    content: string;
    category: string;
    sourceId?: string;
    observedAt: string;
  }): MemoryMutationReceiptV2 {
    return this.truth.remember({
      content: input.content,
      category: input.category,
      address: input.actor,
      lifecycle: "active",
      verification: "user_confirmed",
      source: { sourceType: "user_message", sourceId: input.sourceId, observedAt: input.observedAt },
      actor: `principal:${input.actor.principalId}`,
      reason: "explicit_agent_facade_remember",
    });
  }

  correct(input: {
    actor: MemoryAddressV2;
    itemId: string;
    content: string;
    sourceId?: string;
    observedAt: string;
  }): MemoryMutationReceiptV2 {
    this.requireAccessible(input.actor, input.itemId, "correct");
    return this.truth.correct({
      itemId: input.itemId,
      content: input.content,
      verification: "user_confirmed",
      source: { sourceType: "user_message", sourceId: input.sourceId, observedAt: input.observedAt },
      actor: `principal:${input.actor.principalId}`,
      reason: "explicit_agent_facade_correction",
    });
  }

  forget(input: { actor: MemoryAddressV2; itemId: string; reason: string }): MemoryMutationReceiptV2 {
    this.requireAccessible(input.actor, input.itemId, "forget");
    return this.truth.forget({
      itemId: input.itemId,
      actor: `principal:${input.actor.principalId}`,
      reason: input.reason,
    });
  }
}
