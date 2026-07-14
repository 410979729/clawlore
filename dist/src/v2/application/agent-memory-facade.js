import { decideMemoryAccess } from "./policy-decision.js";
export const CLAWLORE_AGENT_ACTIONS = [
    "memory_query",
    "memory_remember",
    "memory_correct",
    "memory_forget",
];
export class AgentMemoryFacadeV2 {
    truth;
    constructor(truth) {
        this.truth = truth;
    }
    requireAccessible(actor, itemId, operation) {
        const current = this.truth.get(itemId);
        if (!current)
            throw new Error("memory item is not accessible to actor");
        const decision = decideMemoryAccess({
            actor,
            target: current.address,
            operation,
            mode: "explicit",
        });
        if (!decision.allowed)
            throw new Error("memory item is not accessible to actor");
        return current;
    }
    query(actor, query, limit) {
        return this.truth.queryAccessible(actor, query, limit);
    }
    remember(input) {
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
    correct(input) {
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
    forget(input) {
        this.requireAccessible(input.actor, input.itemId, "forget");
        return this.truth.forget({
            itemId: input.itemId,
            actor: `principal:${input.actor.principalId}`,
            reason: input.reason,
        });
    }
}
