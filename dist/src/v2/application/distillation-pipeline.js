import { createHash } from "node:crypto";
import { memoryAddressKey, validateMemoryAddress } from "../domain/memory-address.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "../../capture-safety.js";
import { assertMemoryAddressIdentifiersSafe, normalizeIsoTimestamp, normalizeTruthIdentifier, } from "../domain/truth-write-policy.js";
function normalizedContent(value) {
    return value.replace(/\s+/g, " ").trim();
}
const TRIGGERS = new Set([
    "explicit", "auto_capture", "reflection", "digest", "task_experience",
]);
const CATEGORIES = new Set([
    "profile", "preference", "fact", "decision", "commitment", "procedure", "pitfall",
]);
const SOURCE_ROLES = new Set(["user", "assistant", "tool"]);
function safeIdentifiers(values, label, maxItems = 256) {
    if (values == null)
        return [];
    if (!Array.isArray(values) || values.length > maxItems) {
        throw new Error(`${label} list exceeds the size limit`);
    }
    return [...new Set(values.map((value) => normalizeTruthIdentifier(value, label, 512)))].sort();
}
function safeProviderText(value, label, required) {
    if (value == null && !required)
        return undefined;
    if (typeof value !== "string" || value.length > 64_000) {
        throw new Error(`${label} rejected by safety policy`);
    }
    const sanitized = sanitizeCaptureText(value);
    if (!sanitized) {
        if (required)
            throw new Error(`${label} rejected by safety policy`);
        return undefined;
    }
    if (!evaluateCaptureSafety(sanitized).allowed) {
        if (required)
            throw new Error(`${label} rejected by safety policy`);
        return undefined;
    }
    return sanitized;
}
function normalizeEvent(event) {
    if (!event || typeof event !== "object")
        throw new Error("distillation event is required");
    if (!validateMemoryAddress(event.address).valid)
        throw new Error("invalid distillation memory address");
    assertMemoryAddressIdentifiersSafe(event.address);
    const trigger = event.trigger ?? "explicit";
    if (!TRIGGERS.has(trigger))
        throw new Error("distillation trigger is unsupported");
    return {
        ...event,
        eventId: normalizeTruthIdentifier(event.eventId, "distillation event id", 512),
        trigger,
        sourceIds: safeIdentifiers(event.sourceIds, "distillation source id"),
        toolReceiptIds: safeIdentifiers(event.toolReceiptIds, "distillation tool receipt id"),
        userText: safeProviderText(event.userText, "distillation user text", true),
        assistantText: safeProviderText(event.assistantText, "distillation assistant text", false),
        observedAt: normalizeIsoTimestamp(event.observedAt, "distillation observedAt"),
    };
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
    if (!proposal || typeof proposal !== "object"
        || !CATEGORIES.has(proposal.category) || !SOURCE_ROLES.has(proposal.sourceRole)) {
        return { allowed: false, reason: "proposal_shape_invalid", lifecycle: "candidate", verification: "unverified" };
    }
    if (typeof proposal.content !== "string") {
        return { allowed: false, reason: "proposal_shape_invalid", lifecycle: "candidate", verification: "unverified" };
    }
    const content = normalizedContent(proposal.content);
    if (!content || content.length < 4)
        return { allowed: false, reason: "content_too_short", lifecycle: "candidate", verification: "unverified" };
    if (content.length > 4_000)
        return { allowed: false, reason: "content_too_long", lifecycle: "candidate", verification: "unverified" };
    const captureSafety = evaluateCaptureSafety(content);
    if (sanitizeCaptureText(content) !== content || !captureSafety.allowed) {
        const reason = captureSafety.reason === "secret" ? "secret_shaped_content" : "capture_unsafe_content";
        return { allowed: false, reason, lifecycle: "candidate", verification: "unverified" };
    }
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
    async process(rawEvent) {
        const event = normalizeEvent(rawEvent);
        if (await this.journal.has(event.eventId)) {
            return {
                schemaVersion: 2, eventId: event.eventId, trigger: event.trigger ?? "explicit",
                payloadHash: payloadHash(event), proposalCount: 0,
                admittedCount: 0, rejectedCount: 0, duplicateCount: 0, itemIds: [],
                rejectionReasons: ["idempotent_event_already_processed"], createdAt: event.observedAt,
            };
        }
        const proposals = await this.extractor.extract(event);
        if (!Array.isArray(proposals) || proposals.length > 256) {
            throw new Error("distillation proposal list exceeds the size limit");
        }
        const itemIds = [];
        const rejectionReasons = [];
        let duplicates = 0;
        let rejected = 0;
        for (const proposal of proposals) {
            const decision = admission(proposal, event);
            if (!decision.allowed) {
                rejected += 1;
                rejectionReasons.push(decision.reason);
                continue;
            }
            const key = proposalKey(proposal, event.address);
            if (this.seen.has(key)) {
                duplicates += 1;
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
