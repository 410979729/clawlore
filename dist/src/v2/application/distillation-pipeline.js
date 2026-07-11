import { createHash } from "node:crypto";
import { memoryAddressKey } from "../domain/memory-address.js";
const SECRET_PATTERNS = [
    /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]{8,}/i,
    /\bsk-[A-Za-z0-9_-]{12,}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
function normalizedContent(value) {
    return value.replace(/\s+/g, " ").trim();
}
function proposalKey(proposal, address) {
    return createHash("sha256")
        .update(`${memoryAddressKey(address)}\n${proposal.category}\n${normalizedContent(proposal.content).toLowerCase()}`)
        .digest("hex");
}
function payloadHash(event) {
    return createHash("sha256")
        .update(JSON.stringify({
        eventId: event.eventId,
        trigger: event.trigger ?? "explicit",
        sourceIds: event.sourceIds ?? [],
        address: memoryAddressKey(event.address),
        userText: event.userText,
        assistantText: event.assistantText ?? "",
        toolReceiptIds: event.toolReceiptIds ?? [],
    }))
        .digest("hex");
}
function admission(proposal, event) {
    const content = normalizedContent(proposal.content);
    if (!content || content.length < 4)
        return { allowed: false, reason: "content_too_short", lifecycle: "candidate", verification: "unverified" };
    if (content.length > 4_000)
        return { allowed: false, reason: "content_too_long", lifecycle: "candidate", verification: "unverified" };
    if (SECRET_PATTERNS.some((pattern) => pattern.test(content)))
        return { allowed: false, reason: "secret_shaped_content", lifecycle: "candidate", verification: "unverified" };
    if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0.55)
        return { allowed: false, reason: "confidence_below_threshold", lifecycle: "candidate", verification: "unverified" };
    if (event.explicitRemember === true && proposal.sourceRole === "user") {
        return { allowed: true, reason: "explicit_user_remember", lifecycle: "active", verification: "user_confirmed" };
    }
    if (event.toolVerified === true && proposal.sourceRole === "tool" && (event.toolReceiptIds?.length ?? 0) > 0) {
        if (event.forceCandidate === true) {
            return { allowed: true, reason: "candidate_review_required", lifecycle: "candidate", verification: "tool_verified" };
        }
        return { allowed: true, reason: "tool_receipt_verified", lifecycle: "active", verification: "tool_verified" };
    }
    return { allowed: true, reason: "candidate_review_required", lifecycle: "candidate", verification: "unverified" };
}
export class UnifiedDistillationPipelineV2 {
    truth;
    journal;
    extractor;
    seen = new Set();
    constructor(truth, journal, extractor) {
        this.truth = truth;
        this.journal = journal;
        this.extractor = extractor;
    }
    async process(event) {
        if (await this.journal.has(event.eventId)) {
            return {
                schemaVersion: 2, eventId: event.eventId, trigger: event.trigger ?? "explicit",
                payloadHash: payloadHash(event), proposalCount: 0,
                admittedCount: 0, rejectedCount: 0, duplicateCount: 0, itemIds: [],
                rejectionReasons: ["idempotent_event_already_processed"], createdAt: event.observedAt,
            };
        }
        const proposals = await this.extractor.extract(event);
        const itemIds = [];
        const rejectionReasons = [];
        let duplicates = 0;
        let rejected = 0;
        for (const proposal of proposals) {
            const key = proposalKey(proposal, event.address);
            if (this.seen.has(key)) {
                duplicates += 1;
                continue;
            }
            const decision = admission(proposal, event);
            if (!decision.allowed) {
                rejected += 1;
                rejectionReasons.push(decision.reason);
                continue;
            }
            this.seen.add(key);
            const receipt = this.truth.remember({
                content: normalizedContent(proposal.content),
                category: proposal.category,
                address: event.address,
                lifecycle: decision.lifecycle,
                verification: decision.verification,
                source: {
                    sourceType: proposal.sourceRole === "tool" ? "tool" : "extractor",
                    sourceId: event.eventId,
                    observedAt: event.observedAt,
                    evidence: {
                        trigger: event.trigger ?? "explicit",
                        sourceIds: event.sourceIds ?? [],
                        ...(proposal.sourceRole === "tool" ? { toolReceiptIds: event.toolReceiptIds ?? [] } : {}),
                    },
                },
                actor: `principal:${event.address.principalId}`,
                reason: decision.reason,
            });
            itemIds.push(receipt.itemId);
        }
        const receipt = {
            schemaVersion: 2, eventId: event.eventId, trigger: event.trigger ?? "explicit", payloadHash: payloadHash(event),
            proposalCount: proposals.length, admittedCount: itemIds.length, rejectedCount: rejected,
            duplicateCount: duplicates, itemIds, rejectionReasons: [...new Set(rejectionReasons)].sort(),
            createdAt: event.observedAt,
        };
        await this.journal.append(receipt);
        return receipt;
    }
}
export class InMemoryDistillationJournalV2 {
    receipts = [];
    async has(eventId) { return this.receipts.some((item) => item.eventId === eventId); }
    async append(receipt) { this.receipts.push(receipt); }
}
