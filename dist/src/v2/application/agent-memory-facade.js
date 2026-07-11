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
        const current = this.truth.get(input.itemId);
        if (!current || current.address.tenantId !== input.actor.tenantId
            || current.address.agentId !== input.actor.agentId
            || current.address.principalId !== input.actor.principalId) {
            throw new Error("memory item is not accessible to actor");
        }
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
        const current = this.truth.get(input.itemId);
        if (!current || current.address.tenantId !== input.actor.tenantId
            || current.address.agentId !== input.actor.agentId
            || current.address.principalId !== input.actor.principalId) {
            throw new Error("memory item is not accessible to actor");
        }
        return this.truth.forget({
            itemId: input.itemId,
            actor: `principal:${input.actor.principalId}`,
            reason: input.reason,
        });
    }
}
