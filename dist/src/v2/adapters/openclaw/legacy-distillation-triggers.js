import { createHash } from "node:crypto";
import { memoryAddressKey } from "../../domain/memory-address.js";
function compact(value) {
    return value.replace(/\s+/g, " ").trim();
}
function eventId(trigger, input) {
    const digest = createHash("sha256")
        .update(`${trigger}\n${memoryAddressKey(input.address)}\n${input.sourceId}`)
        .digest("hex")
        .slice(0, 20);
    return `legacy-${trigger}-${digest}`;
}
function base(trigger, input) {
    if (!input.sourceId.trim())
        throw new Error(`${trigger} source id is required`);
    return {
        eventId: eventId(trigger, input),
        trigger,
        sourceIds: [input.sourceId.trim()],
        address: input.address,
        observedAt: input.observedAt,
        forceCandidate: true,
    };
}
export function adaptLegacyAutoCaptureTriggerV2(input) {
    return {
        ...base("auto_capture", input),
        userText: input.userMessages.map(compact).filter(Boolean).join("\n"),
        assistantText: compact(input.assistantText ?? "") || undefined,
    };
}
export function adaptLegacyReflectionTriggerV2(input) {
    return {
        ...base("reflection", input),
        userText: compact(input.command ?? "session reflection"),
        assistantText: compact(input.reflectionText),
        sourceIds: [input.sourceId.trim(), `fallback:${input.usedFallback === true ? "yes" : "no"}`],
    };
}
export function adaptLegacyDigestTriggerV2(input) {
    if (!input.digestRunId.trim())
        throw new Error("digest run id is required");
    return {
        ...base("digest", input),
        userText: "digest candidate review",
        assistantText: compact(input.candidateText),
        sourceIds: [input.sourceId.trim(), input.digestRunId.trim()],
    };
}
export function adaptLegacyTaskExperienceTriggerV2(input) {
    if (!input.episodeId.trim())
        throw new Error("task experience episode id is required");
    const toolReceiptIds = [...new Set((input.toolReceiptIds ?? []).map((value) => value.trim()).filter(Boolean))];
    return {
        ...base("task_experience", input),
        userText: compact(input.userGoal),
        assistantText: compact(input.capsuleText),
        sourceIds: [input.sourceId.trim(), input.episodeId.trim()],
        toolVerified: input.verified === true && toolReceiptIds.length > 0,
        toolReceiptIds,
    };
}
