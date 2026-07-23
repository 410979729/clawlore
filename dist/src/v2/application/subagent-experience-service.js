import { memoryAddressKey, validateMemoryAddress } from "../domain/memory-address.js";
import { containsSecret } from "../../secret-redaction.js";
import { evaluateCaptureSafety, sanitizeCaptureText } from "../../capture-safety.js";
import { assertMemoryAddressIdentifiersSafe } from "../domain/truth-write-policy.js";
function requiredText(value, label, maxLength = 4_000) {
    if (typeof value !== "string")
        throw new Error(`${label} is required`);
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized)
        throw new Error(`${label} is required`);
    if (normalized.length > maxLength)
        throw new Error(`${label} exceeds the size limit`);
    return normalized;
}
function requiredIdentifierText(value, label, maxLength = 512) {
    const normalized = requiredText(value, label, maxLength);
    if (containsSecret(value) || containsSecret(normalized)
        || sanitizeCaptureText(normalized) !== normalized) {
        throw new Error(`${label} rejected by safety policy`);
    }
    const safety = evaluateCaptureSafety(normalized);
    if (!safety.allowed && safety.reason !== "trivial" && safety.reason !== "progress-noise") {
        throw new Error(`${label} rejected by safety policy`);
    }
    return normalized;
}
function requiredSemanticText(value, label, maxLength = 4_000) {
    const normalized = requiredText(value, label, maxLength);
    const sanitized = sanitizeCaptureText(normalized);
    if (containsSecret(value) || containsSecret(normalized)
        || sanitized !== normalized || !evaluateCaptureSafety(sanitized).allowed) {
        throw new Error(`${label} rejected by safety policy`);
    }
    return normalized;
}
function identifierUnique(values, label = "value", maxItems = 256, maxLength = 512) {
    if (!Array.isArray(values))
        throw new Error(`${label} list is required`);
    if (values.length > maxItems)
        throw new Error(`${label} list exceeds the size limit`);
    return [...new Set(values.map((value) => requiredIdentifierText(value, label, maxLength)))].sort();
}
function semanticUnique(values, label, maxItems = 128, maxLength = 4_000) {
    if (!Array.isArray(values))
        throw new Error(`${label} list is required`);
    if (values.length > maxItems)
        throw new Error(`${label} list exceeds the size limit`);
    return [...new Set(values.map((value) => requiredSemanticText(value, label, maxLength)))].sort();
}
function packItems(pack) {
    return [pack.profile, pack.projectFacts, pack.activeDecisions, pack.taskContext, pack.playbooks].flat();
}
function normalizeSteps(steps) {
    if (!Array.isArray(steps) || steps.length > 128)
        throw new Error("playbook steps exceed the size limit");
    if (steps.length === 0)
        throw new Error("playbook requires ordered steps");
    const normalized = steps.map((step) => ({
        stepId: requiredIdentifierText(step.stepId, "step id", 256),
        instruction: requiredSemanticText(step.instruction, "step instruction"),
        requiredTools: identifierUnique(step.requiredTools, "required tool", 64, 256),
    }));
    if (new Set(normalized.map((step) => step.stepId)).size !== normalized.length) {
        throw new Error("playbook step ids must be unique");
    }
    return normalized;
}
function normalizeGates(gates) {
    if (!Array.isArray(gates) || gates.length > 128)
        throw new Error("playbook gates exceed the size limit");
    if (gates.length === 0)
        throw new Error("playbook requires verification gates");
    const normalized = gates.map((gate) => ({
        gateId: requiredIdentifierText(gate.gateId, "gate id", 256),
        description: requiredSemanticText(gate.description, "gate description"),
    }));
    if (new Set(normalized.map((gate) => gate.gateId)).size !== normalized.length) {
        throw new Error("playbook gate ids must be unique");
    }
    return normalized;
}
export class SubagentExperienceServiceV2 {
    store;
    clock;
    constructor(store, clock) {
        this.store = store;
        this.clock = clock;
    }
    prepareSpawn(input) {
        if (!validateMemoryAddress(input.actor).valid)
            throw new Error("invalid subagent actor address");
        assertMemoryAddressIdentifiersSafe(input.actor);
        if (memoryAddressKey(input.actor) !== memoryAddressKey(input.contextPack.actorAddress)) {
            throw new Error("ContextPack actor does not match subagent actor");
        }
        const parentSessionId = requiredIdentifierText(input.parentSessionId, "parent session id", 512);
        const childSessionId = requiredIdentifierText(input.childSessionId, "child session id", 512);
        if (parentSessionId === childSessionId)
            throw new Error("child session must differ from parent session");
        const authorized = new Set(identifierUnique(input.explicitlyAuthorizedMemoryIds ?? [], "authorized memory id", 256, 512));
        const selected = packItems(input.contextPack).filter((memory) => input.mode === "fork"
            || (authorized.has(memory.id) && memory.address.visibility !== "private"));
        const snapshot = {
            schemaVersion: 2,
            snapshotId: this.clock.id("snapshot"),
            mode: input.mode,
            parentSessionId,
            childSessionId,
            runId: requiredIdentifierText(input.runId, "run id", 512),
            taskGoal: requiredSemanticText(input.taskGoal, "task goal"),
            actorAddress: input.actor,
            items: selected.map((memory) => {
                if (!validateMemoryAddress(memory.address).valid)
                    throw new Error("invalid context memory address");
                assertMemoryAddressIdentifiersSafe(memory.address);
                return {
                    memoryId: requiredIdentifierText(memory.id, "context memory id", 512),
                    section: memory.section,
                    text: requiredSemanticText(memory.text, "context memory text", 16_000),
                    address: memory.address,
                    verification: memory.verification,
                    readOnly: true,
                };
            }),
            status: "active",
            createdAt: this.clock.now().toISOString(),
        };
        this.store.saveSnapshot(snapshot);
        this.event("snapshot", snapshot.snapshotId, "subagent_snapshot_created", `session:${parentSessionId}`, input.mode);
        return snapshot;
    }
    recordChildScratch(input) {
        const snapshot = this.requireSnapshot(input.snapshotId, input.childSessionId);
        if (input.retention === "durable")
            throw new Error("child durable memory writes are denied");
        const content = requiredSemanticText(input.content, "child scratch content");
        const scratch = {
            scratchId: this.clock.id("scratch"), snapshotId: snapshot.snapshotId,
            childSessionId: snapshot.childSessionId, content, retention: input.retention,
            lifecycle: "candidate", createdAt: this.clock.now().toISOString(),
        };
        this.store.saveScratch(scratch);
        this.event("scratch", scratch.scratchId, "child_candidate_recorded", `session:${snapshot.childSessionId}`, input.retention);
        return scratch;
    }
    onSubagentEnded(input) {
        const snapshot = this.requireSnapshot(input.snapshotId, input.childSessionId);
        const now = this.clock.now().toISOString();
        const episode = {
            schemaVersion: 2,
            episodeId: this.clock.id("episode"),
            snapshotId: snapshot.snapshotId,
            parentSessionId: snapshot.parentSessionId,
            childSessionId: snapshot.childSessionId,
            runId: snapshot.runId,
            taskClass: requiredIdentifierText(input.taskClass, "task class", 256),
            taskGoal: snapshot.taskGoal,
            actorAddress: snapshot.actorAddress,
            outcome: input.outcome,
            toolReceiptIds: identifierUnique(input.toolReceiptIds ?? [], "tool receipt id", 256, 512),
            evidence: semanticUnique(input.evidence ?? [], "episode evidence"),
            parentVerification: "pending",
            lifecycle: "candidate",
            createdAt: now,
            updatedAt: now,
        };
        this.store.finalizeSnapshot({ ...snapshot, status: "revoked" }, episode);
        this.event("episode", episode.episodeId, "child_episode_candidate_created", `session:${snapshot.childSessionId}`, input.outcome);
        return episode;
    }
    verifyByParent(input) {
        const episode = this.requireEpisode(input.episodeId);
        if (episode.parentSessionId !== input.parentSessionId)
            throw new Error("parent session does not own episode");
        const reason = requiredSemanticText(input.reason, "verification reason");
        const hasReceipts = episode.toolReceiptIds.length > 0 && episode.evidence.length > 0;
        const accepted = input.accepted && episode.outcome === "success" && hasReceipts;
        const updated = {
            ...episode,
            parentVerification: accepted ? "parent_verified" : "disputed",
            lifecycle: accepted ? "candidate" : "quarantined",
            verificationReason: reason,
            updatedAt: this.clock.now().toISOString(),
        };
        this.store.updateEpisode(updated, episode);
        this.event("episode", updated.episodeId, accepted ? "parent_verified" : "episode_quarantined", `session:${input.parentSessionId}`, reason);
        return updated;
    }
    createPlaybookCandidate(input) {
        if (!validateMemoryAddress(input.actor).valid)
            throw new Error("invalid playbook actor address");
        assertMemoryAddressIdentifiersSafe(input.actor);
        const episodeIds = identifierUnique(input.episodeIds, "episode id", 256, 512);
        const episodes = this.store.listEpisodes(episodeIds);
        if (episodes.length !== episodeIds.length)
            throw new Error("playbook evidence episode is missing");
        if (episodes.some((episode) => episode.outcome !== "success" || episode.parentVerification !== "parent_verified")) {
            throw new Error("playbook evidence requires parent-verified successful episodes");
        }
        if (episodes.some((episode) => episode.parentSessionId !== input.parentSessionId
            || memoryAddressKey(episode.actorAddress) !== memoryAddressKey(input.actor))) {
            throw new Error("playbook evidence is not owned by the parent actor");
        }
        const taskClasses = new Set(episodes.map((episode) => episode.taskClass));
        const scopes = new Set(episodes.map((episode) => memoryAddressKey(episode.actorAddress)));
        if (taskClasses.size !== 1 || scopes.size !== 1)
            throw new Error("playbook evidence must share task class and scope");
        const steps = normalizeSteps(input.steps);
        const verificationGates = normalizeGates(input.verificationGates);
        const now = this.clock.now().toISOString();
        const playbook = {
            schemaVersion: 2,
            playbookId: this.clock.id("playbook"),
            version: 1,
            taskClass: episodes[0].taskClass,
            title: requiredSemanticText(input.title, "playbook title", 512),
            trigger: requiredSemanticText(input.trigger, "playbook trigger"),
            scopeAddress: episodes[0].actorAddress,
            prerequisites: semanticUnique(input.prerequisites, "playbook prerequisite"),
            steps,
            verificationGates,
            risks: semanticUnique(input.risks, "playbook risk"),
            cleanup: semanticUnique(input.cleanup, "playbook cleanup"),
            evidenceEpisodeIds: episodeIds,
            lifecycle: "candidate",
            operatorReviewed: false,
            createdAt: now,
            updatedAt: now,
        };
        this.store.savePlaybook(playbook);
        this.event("playbook", playbook.playbookId, "playbook_candidate_created", "parent", `${episodeIds.length}_episodes`);
        return playbook;
    }
    promotePlaybook(input) {
        const playbook = this.requirePlaybook(input.playbookId);
        const actor = requiredIdentifierText(input.actor, "promotion actor", 512);
        const reason = requiredSemanticText(input.reason, "promotion reason");
        if (playbook.lifecycle !== "candidate")
            throw new Error("only candidate playbooks can be promoted");
        const episodes = this.store.listEpisodes(playbook.evidenceEpisodeIds);
        const repeatVerified = new Set(episodes
            .filter((episode) => episode.outcome === "success" && episode.parentVerification === "parent_verified")
            .map((episode) => episode.runId)).size >= 2;
        if (input.operatorReviewed !== true && !repeatVerified) {
            throw new Error("single-run playbook cannot be promoted without operator review");
        }
        const updated = {
            ...playbook,
            lifecycle: "promoted",
            operatorReviewed: playbook.operatorReviewed || input.operatorReviewed === true,
            updatedAt: this.clock.now().toISOString(),
        };
        this.store.updatePlaybook(updated, playbook);
        this.event("playbook", updated.playbookId, "playbook_promoted", actor, reason);
        return updated;
    }
    quarantinePlaybook(input) {
        const playbook = this.requirePlaybook(input.playbookId);
        const actor = requiredIdentifierText(input.actor, "quarantine actor", 512);
        const reason = requiredSemanticText(input.reason, "quarantine reason");
        const updated = { ...playbook, lifecycle: "quarantined", updatedAt: this.clock.now().toISOString() };
        this.store.updatePlaybook(updated, playbook);
        this.event("playbook", updated.playbookId, "playbook_quarantined", actor, reason);
        return updated;
    }
    supersedePlaybook(input) {
        const previous = this.requirePlaybook(input.playbookId);
        const actor = requiredIdentifierText(input.actor, "supersede actor", 512);
        const reason = requiredSemanticText(input.reason, "supersede reason");
        if (previous.lifecycle !== "promoted")
            throw new Error("only promoted playbooks can be superseded");
        const steps = normalizeSteps(input.steps);
        const verificationGates = normalizeGates(input.verificationGates);
        const now = this.clock.now().toISOString();
        const next = {
            ...previous,
            playbookId: this.clock.id("playbook"),
            version: previous.version + 1,
            steps,
            verificationGates,
            lifecycle: "candidate",
            operatorReviewed: false,
            predecessorId: previous.playbookId,
            supersededBy: undefined,
            createdAt: now,
            updatedAt: now,
        };
        this.store.supersedePlaybook(previous, next, {
            eventId: this.clock.id("event"),
            entityType: "playbook",
            entityId: previous.playbookId,
            eventType: "playbook_superseded",
            actor,
            reason,
            createdAt: now,
        });
        return next;
    }
    evaluateReplay(input) {
        if (!validateMemoryAddress(input.actor).valid)
            throw new Error("invalid replay actor address");
        assertMemoryAddressIdentifiersSafe(input.actor);
        const playbook = this.requirePlaybook(input.playbookId);
        const scopeMatches = memoryAddressKey(playbook.scopeAddress) === memoryAddressKey(input.actor);
        const availableTools = new Set(identifierUnique(input.availableTools));
        const satisfiedPrerequisites = new Set(semanticUnique(input.satisfiedPrerequisites, "satisfied prerequisite"));
        const completedSteps = new Set(identifierUnique(input.completedStepIds));
        const passedGates = new Set(identifierUnique(input.passedGateIds));
        const disabledSteps = identifierUnique(input.disabledStepIds ?? []);
        const missingTools = identifierUnique(playbook.steps.flatMap((step) => step.requiredTools).filter((tool) => !availableTools.has(tool)));
        const missingPrerequisites = playbook.prerequisites.filter((item) => !satisfiedPrerequisites.has(item));
        const missingSteps = playbook.steps.map((step) => step.stepId).filter((id) => !completedSteps.has(id));
        const missingVerificationGates = playbook.verificationGates.map((gate) => gate.gateId).filter((id) => !passedGates.has(id));
        const passed = playbook.lifecycle === "promoted" && scopeMatches && input.outcome === "success"
            && missingTools.length === 0 && missingPrerequisites.length === 0
            && missingSteps.length === 0 && missingVerificationGates.length === 0 && disabledSteps.length === 0;
        const result = {
            replayId: this.clock.id("replay"), playbookId: playbook.playbookId,
            passed, safeToUse: passed, missingTools, missingPrerequisites, missingSteps,
            missingVerificationGates, disabledSteps,
            reason: passed ? "replay_quality_gates_passed" : "replay_quality_gates_failed",
            evaluatedAt: this.clock.now().toISOString(),
        };
        this.event("replay", result.replayId, result.reason, "replay", playbook.playbookId);
        return result;
    }
    recordFeedback(input) {
        if (input.outcome === "failure")
            return this.quarantinePlaybook(input);
        const playbook = this.requirePlaybook(input.playbookId);
        const actor = requiredIdentifierText(input.actor, "feedback actor", 512);
        const reason = requiredSemanticText(input.reason, "feedback reason");
        this.event("playbook", playbook.playbookId, `playbook_feedback_${input.outcome}`, actor, reason);
        return playbook;
    }
    requireSnapshot(snapshotId, childSessionId) {
        const snapshot = this.store.getSnapshot(snapshotId);
        if (!snapshot || snapshot.status !== "active")
            throw new Error("active subagent snapshot not found");
        if (snapshot.childSessionId !== childSessionId)
            throw new Error("child session does not own snapshot");
        return snapshot;
    }
    requireEpisode(episodeId) {
        const episode = this.store.getEpisode(episodeId);
        if (!episode)
            throw new Error("experience episode not found");
        return episode;
    }
    requirePlaybook(playbookId) {
        const playbook = this.store.getPlaybook(playbookId);
        if (!playbook)
            throw new Error("procedural playbook not found");
        return playbook;
    }
    event(entityType, entityId, eventType, actor, reason) {
        this.store.appendEvent({
            eventId: this.clock.id("event"), entityType, entityId, eventType,
            actor, reason, createdAt: this.clock.now().toISOString(),
        });
    }
}
