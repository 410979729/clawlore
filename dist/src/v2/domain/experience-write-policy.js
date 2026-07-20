import { validateMemoryAddress } from "./memory-address.js";
import { assertMemoryAddressIdentifiersSafe, normalizeIsoTimestamp, normalizeTruthIdentifier, normalizeTruthSemanticText, } from "./truth-write-policy.js";
const CONTEXT_SECTIONS = new Set(["profile", "projectFacts", "activeDecisions", "taskContext", "playbooks"]);
const VERIFICATIONS = new Set(["unverified", "user_confirmed", "tool_verified", "operator_reviewed", "disputed"]);
const EPISODE_OUTCOMES = new Set(["success", "failure", "blocked", "incomplete"]);
const PARENT_VERIFICATIONS = new Set(["pending", "parent_verified", "disputed"]);
const EXPERIENCE_LIFECYCLES = new Set(["candidate", "promoted", "quarantined", "superseded"]);
const EVENT_ENTITY_TYPES = new Set(["snapshot", "scratch", "episode", "playbook", "replay"]);
function exactIdentifier(value, label, maxLength = 512) {
    const normalized = normalizeTruthIdentifier(value, label, maxLength);
    if (normalized !== value)
        throw new Error(`${label} contains invalid boundary whitespace`);
    return normalized;
}
function exactSemantic(value, label, maxLength = 4_000) {
    const normalized = normalizeTruthSemanticText(value, label, maxLength, { collapseWhitespace: false });
    if (normalized !== value)
        throw new Error(`${label} contains invalid boundary whitespace`);
    return normalized;
}
function identifierList(value, label, maxItems = 256, maxLength = 512) {
    if (!Array.isArray(value) || value.length > maxItems)
        throw new Error(`${label} list exceeds the size limit`);
    const normalized = value.map((item) => exactIdentifier(item, label, maxLength));
    if (new Set(normalized).size !== normalized.length)
        throw new Error(`${label} list contains duplicates`);
    return normalized;
}
function semanticList(value, label, maxItems = 128, maxLength = 4_000) {
    if (!Array.isArray(value) || value.length > maxItems)
        throw new Error(`${label} list exceeds the size limit`);
    const normalized = value.map((item) => exactSemantic(item, label, maxLength));
    if (new Set(normalized).size !== normalized.length)
        throw new Error(`${label} list contains duplicates`);
    return normalized;
}
function address(value, label) {
    const validation = validateMemoryAddress(value);
    if (!validation.valid)
        throw new Error(`${label} is invalid`);
    assertMemoryAddressIdentifiersSafe(value);
}
function timestamp(value, label) {
    normalizeIsoTimestamp(value, label);
}
export function assertSubagentSnapshotSafeForPersistence(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || snapshot.schemaVersion !== 2) {
        throw new Error("subagent snapshot schema is unsupported");
    }
    exactIdentifier(snapshot.snapshotId, "snapshot id");
    exactIdentifier(snapshot.parentSessionId, "parent session id");
    exactIdentifier(snapshot.childSessionId, "child session id");
    exactIdentifier(snapshot.runId, "run id");
    if (snapshot.parentSessionId === snapshot.childSessionId)
        throw new Error("child session must differ from parent session");
    if (snapshot.mode !== "isolated" && snapshot.mode !== "fork")
        throw new Error("subagent mode is unsupported");
    if (snapshot.status !== "active" && snapshot.status !== "revoked")
        throw new Error("subagent status is unsupported");
    exactSemantic(snapshot.taskGoal, "task goal");
    address(snapshot.actorAddress, "subagent actor address");
    if (!Array.isArray(snapshot.items) || snapshot.items.length > 256) {
        throw new Error("subagent context item list exceeds the size limit");
    }
    const memoryIds = snapshot.items.map((item) => {
        if (!item || typeof item !== "object")
            throw new Error("subagent context item is required");
        const memoryId = exactIdentifier(item.memoryId, "context memory id");
        if (!CONTEXT_SECTIONS.has(item.section))
            throw new Error("context memory section is unsupported");
        exactSemantic(item.text, "context memory text", 16_000);
        address(item.address, "context memory address");
        if (!VERIFICATIONS.has(item.verification))
            throw new Error("context memory verification is unsupported");
        if (item.readOnly !== true)
            throw new Error("subagent context memory must be read-only");
        return memoryId;
    });
    if (new Set(memoryIds).size !== memoryIds.length)
        throw new Error("context memory ids must be unique");
    timestamp(snapshot.createdAt, "snapshot createdAt");
}
export function assertChildScratchSafeForPersistence(scratch) {
    if (!scratch || typeof scratch !== "object")
        throw new Error("child scratch is required");
    exactIdentifier(scratch.scratchId, "scratch id");
    exactIdentifier(scratch.snapshotId, "snapshot id");
    exactIdentifier(scratch.childSessionId, "child session id");
    exactSemantic(scratch.content, "child scratch content");
    if (scratch.retention !== "ephemeral" && scratch.retention !== "working") {
        throw new Error("child scratch retention is unsupported");
    }
    if (scratch.lifecycle !== "candidate")
        throw new Error("child scratch must remain candidate");
    timestamp(scratch.createdAt, "scratch createdAt");
}
export function assertExperienceEpisodeSafeForPersistence(episode) {
    if (!episode || typeof episode !== "object" || episode.schemaVersion !== 2) {
        throw new Error("experience episode schema is unsupported");
    }
    exactIdentifier(episode.episodeId, "episode id");
    exactIdentifier(episode.snapshotId, "snapshot id");
    exactIdentifier(episode.parentSessionId, "parent session id");
    exactIdentifier(episode.childSessionId, "child session id");
    exactIdentifier(episode.runId, "run id");
    exactIdentifier(episode.taskClass, "task class", 256);
    exactSemantic(episode.taskGoal, "task goal");
    address(episode.actorAddress, "episode actor address");
    if (!EPISODE_OUTCOMES.has(episode.outcome))
        throw new Error("episode outcome is unsupported");
    identifierList(episode.toolReceiptIds, "tool receipt id");
    semanticList(episode.evidence, "episode evidence");
    if (!PARENT_VERIFICATIONS.has(episode.parentVerification)) {
        throw new Error("parent verification is unsupported");
    }
    if (!EXPERIENCE_LIFECYCLES.has(episode.lifecycle))
        throw new Error("episode lifecycle is unsupported");
    if (episode.parentVerification === "parent_verified"
        && (episode.outcome !== "success" || episode.toolReceiptIds.length === 0 || episode.evidence.length === 0)) {
        throw new Error("parent-verified episode requires successful receipt-backed evidence");
    }
    if ((episode.parentVerification === "disputed") !== (episode.lifecycle === "quarantined")) {
        throw new Error("episode verification and lifecycle are inconsistent");
    }
    if (episode.parentVerification === "pending" && episode.lifecycle !== "candidate") {
        throw new Error("pending episode must remain candidate");
    }
    if (episode.verificationReason != null)
        exactSemantic(episode.verificationReason, "verification reason");
    timestamp(episode.createdAt, "episode createdAt");
    timestamp(episode.updatedAt, "episode updatedAt");
}
export function assertProceduralPlaybookSafeForPersistence(playbook) {
    if (!playbook || typeof playbook !== "object" || playbook.schemaVersion !== 2) {
        throw new Error("procedural playbook schema is unsupported");
    }
    exactIdentifier(playbook.playbookId, "playbook id");
    if (!Number.isSafeInteger(playbook.version) || playbook.version < 1)
        throw new Error("playbook version is invalid");
    exactIdentifier(playbook.taskClass, "task class", 256);
    exactSemantic(playbook.title, "playbook title", 512);
    exactSemantic(playbook.trigger, "playbook trigger");
    address(playbook.scopeAddress, "playbook scope address");
    semanticList(playbook.prerequisites, "playbook prerequisite");
    if (!Array.isArray(playbook.steps) || playbook.steps.length === 0 || playbook.steps.length > 128) {
        throw new Error("playbook steps exceed the size limit");
    }
    const stepIds = playbook.steps.map((step) => {
        const stepId = exactIdentifier(step.stepId, "step id", 256);
        exactSemantic(step.instruction, "step instruction");
        identifierList(step.requiredTools, "required tool", 64, 256);
        return stepId;
    });
    if (new Set(stepIds).size !== stepIds.length)
        throw new Error("playbook step ids must be unique");
    if (!Array.isArray(playbook.verificationGates)
        || playbook.verificationGates.length === 0 || playbook.verificationGates.length > 128) {
        throw new Error("playbook gates exceed the size limit");
    }
    const gateIds = playbook.verificationGates.map((gate) => {
        const gateId = exactIdentifier(gate.gateId, "gate id", 256);
        exactSemantic(gate.description, "gate description");
        return gateId;
    });
    if (new Set(gateIds).size !== gateIds.length)
        throw new Error("playbook gate ids must be unique");
    semanticList(playbook.risks, "playbook risk");
    semanticList(playbook.cleanup, "playbook cleanup");
    identifierList(playbook.evidenceEpisodeIds, "episode id");
    if (!EXPERIENCE_LIFECYCLES.has(playbook.lifecycle))
        throw new Error("playbook lifecycle is unsupported");
    if (typeof playbook.operatorReviewed !== "boolean")
        throw new Error("operator review flag must be boolean");
    if (playbook.predecessorId != null)
        exactIdentifier(playbook.predecessorId, "predecessor id");
    if (playbook.supersededBy != null)
        exactIdentifier(playbook.supersededBy, "superseded playbook id");
    if ((playbook.lifecycle === "superseded") !== (playbook.supersededBy != null)) {
        throw new Error("playbook supersession fields are inconsistent");
    }
    timestamp(playbook.createdAt, "playbook createdAt");
    timestamp(playbook.updatedAt, "playbook updatedAt");
}
export function assertExperienceEventSafeForPersistence(event) {
    if (!event || typeof event !== "object")
        throw new Error("experience event is required");
    exactIdentifier(event.eventId, "experience event id");
    if (!EVENT_ENTITY_TYPES.has(event.entityType))
        throw new Error("experience event entity type is unsupported");
    exactIdentifier(event.entityId, "experience event entity id");
    exactIdentifier(event.eventType, "experience event type", 256);
    exactIdentifier(event.actor, "experience event actor");
    exactSemantic(event.reason, "experience event reason");
    timestamp(event.createdAt, "experience event createdAt");
}
