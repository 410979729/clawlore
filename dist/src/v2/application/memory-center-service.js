import { contextPackItemCount } from "../domain/context-pack.js";
import { memoryAddressKey } from "../domain/memory-address.js";
function toMemory(row) {
    return {
        itemId: row.itemId,
        content: row.content,
        category: row.category,
        address: row.address,
        lifecycle: row.lifecycle,
        verification: row.verification,
        updatedAt: row.updatedAt,
        whyRemembered: {
            sourceType: row.sourceType ?? "unknown",
            sourceId: row.sourceId,
            observedAt: row.observedAt,
            eventType: row.latestEventType,
            reason: row.latestReason,
        },
    };
}
export class MemoryCenterServiceV1 {
    reader;
    now;
    constructor(reader, now = () => new Date()) {
        this.reader = reader;
        this.now = now;
    }
    build(input) {
        if (input.contextPack && memoryAddressKey(input.contextPack.actorAddress) !== memoryAddressKey(input.actor)) {
            throw new Error("ContextPack actor does not match Memory Center actor");
        }
        const now = this.now();
        const nowIso = now.toISOString();
        const rows = this.reader.listMemoryCenterRows(input.actor, input.limit ?? 200);
        const accessibleIds = new Set(rows.map((row) => row.itemId));
        const activeRows = rows.filter((row) => row.lifecycle === "active"
            && row.verification !== "disputed"
            && (!row.validUntil || row.validUntil >= nowIso));
        const activeIds = new Set(activeRows.map((row) => row.itemId));
        const reviewInbox = rows
            .filter((row) => row.lifecycle === "candidate" || row.verification === "disputed")
            .map((row) => ({
            itemId: row.itemId,
            issue: row.verification === "disputed" ? "disputed" : "candidate_review",
            detail: row.verification === "disputed" ? "verification_disputed" : "candidate_requires_review",
        }));
        const conflictsAndStale = rows
            .filter((row) => row.lifecycle === "active" && Boolean(row.validUntil) && row.validUntil < nowIso)
            .map((row) => ({ itemId: row.itemId, issue: "stale", detail: `expired_at:${row.validUntil}` }));
        for (const relation of this.reader.listMemoryCenterRelations(input.actor, input.limit ?? 200)) {
            if (relation.relationType !== "contradicts"
                || !activeIds.has(relation.fromItemId)
                || !activeIds.has(relation.toItemId))
                continue;
            conflictsAndStale.push({
                itemId: relation.fromItemId,
                issue: "conflict",
                detail: "relation_contradicts",
                relatedItemIds: [relation.toItemId],
            });
        }
        const sections = input.contextPack
            ? ["profile", "projectFacts", "activeDecisions", "taskContext", "playbooks"]
                .flatMap((section) => input.contextPack[section])
            : [];
        const usedThisTurn = sections
            .filter((memory) => accessibleIds.has(memory.id))
            .map((memory) => ({
            itemId: memory.id,
            section: memory.section,
            score: memory.score,
            freshness: memory.freshness,
            whyRecalled: `${memory.section}:${memory.citation?.sourceType ?? "unknown_source"}`,
        }));
        if (input.contextPack && usedThisTurn.length > contextPackItemCount(input.contextPack)) {
            throw new Error("Memory Center used-this-turn count is inconsistent");
        }
        const scopes = {};
        for (const row of rows)
            scopes[row.address.visibility] = (scopes[row.address.visibility] ?? 0) + 1;
        const corrections = this.reader.listMemoryCenterEvents(input.actor, input.limit ?? 200)
            .filter((event) => event.eventType === "corrected")
            .map((event) => ({ eventId: event.eventId, itemId: event.itemId, reason: event.reason, createdAt: event.createdAt }));
        return {
            schemaVersion: 1,
            generatedAt: nowIso,
            actorAddress: input.actor,
            whatItKnows: activeRows.map(toMemory),
            usedThisTurn,
            reviewInbox,
            corrections,
            conflictsAndStale,
            scopes,
            projectionHealth: this.reader.getMemoryCenterProjectionHealth(input.actor),
            providerEgress: (input.providerEgress ?? []).map((route) => ({
                ...route,
                provider: route.provider.trim() || "unknown",
                dataClasses: [...new Set(route.dataClasses.map((value) => value.trim()).filter(Boolean))].sort(),
            })),
            capabilities: {
                backup: "encrypted_snapshot",
                portableExport: "explicit_only",
                playbooks: "reviewed_only",
            },
        };
    }
}
