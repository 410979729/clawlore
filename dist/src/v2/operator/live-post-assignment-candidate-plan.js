import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { planCandidatePromotionsV1, } from "../application/candidate-promotion-policy.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function hasDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function privateJson(path) {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
        throw new Error("candidate-plan control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("candidate-plan control JSON is invalid");
    }
    return { value, sha256: hash(bytes) };
}
function parseRecord(value) {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("candidate source evidence is not a JSON object");
    }
    return parsed;
}
function planCore(plan) {
    return {
        proposedRolloutId: plan.proposedRolloutId,
        remediationPlanDigest: plan.remediationPlanDigest,
        remediationPreviewSha256: plan.remediationPreviewSha256,
        sessionsRegistrySha256: plan.sessionsRegistrySha256,
        ...(plan.targetItemSha256Allowlist
            ? { targetItemSha256Allowlist: plan.targetItemSha256Allowlist }
            : {}),
        source: plan.source,
        summary: plan.summary,
        decisions: plan.decisions,
        rows: plan.rows,
    };
}
function loadControls(planPath, acceptancePath) {
    const loadedPlan = privateJson(planPath);
    const loadedAcceptance = privateJson(acceptancePath);
    const plan = loadedPlan.value;
    const acceptance = loadedAcceptance.value;
    if (plan.schemaVersion !== 1
        || plan.phase !== "clawlore-evidence-assignment-plan"
        || plan.readOnly !== true
        || plan.queryOnly !== true
        || plan.emitsMemoryContent !== false
        || plan.emitsTranscriptContent !== false
        || plan.emitsRawIdentifiers !== false
        || plan.automaticPromotionRows !== 0
        || plan.authorizesEvidenceWrite !== false
        || plan.authorizesLifecycleMutation !== false
        || plan.authorizesContextEngine !== false
        || plan.authorizesPromptMutation !== false
        || plan.authorizesFinalRecall !== false
        || !hasDigest(plan.planDigest)
        || hash(JSON.stringify(planCore(plan))) !== plan.planDigest
        || plan.rows.length !== plan.source.candidateRows)
        throw new Error("evidence-assignment plan contract is invalid");
    if (acceptance.schemaVersion !== 1
        || acceptance.phase !== "clawlore-v2-live-evidence-assignment"
        || acceptance.status !== "applied"
        || acceptance.rolloutId !== plan.proposedRolloutId
        || acceptance.planDigest !== plan.planDigest
        || acceptance.planSha256 !== loadedPlan.sha256
        || acceptance.source.unchanged !== true
        || acceptance.evidence.rowsWritten !== plan.summary.proposedEvidenceAssignmentRows
        || acceptance.evidence.directPrincipalRows !== plan.decisions.propose_private_principal_evidence_assignment
        || acceptance.evidence.conversationBoundaryRows !== plan.decisions.propose_conversation_boundary_evidence_assignment
        || acceptance.evidence.manualRowsChanged !== 0
        || acceptance.evidence.externalSourceReceiptRowsChanged !== 0
        || acceptance.evidence.quarantineRowsChanged !== 0
        || acceptance.evidence.nonTargetEvidenceRowsChanged !== 0
        || acceptance.canonical.lifecycleRowsChanged !== 0
        || acceptance.canonical.verificationRowsChanged !== 0
        || acceptance.canonical.addressRowsChanged !== 0
        || acceptance.database.integrity !== "ok"
        || acceptance.database.foreignKeyViolations !== 0
        || acceptance.runtime.v1FallbackReads !== true
        || acceptance.runtime.lifecycleMutationEnabled !== false
        || acceptance.runtime.contextEngineEnabled !== false
        || acceptance.runtime.promptMutationEnabled !== false
        || acceptance.runtime.finalRecallCutoverEnabled !== false)
        throw new Error("evidence-assignment acceptance contract is invalid or unbound");
    return {
        plan,
        acceptance,
        planSha256: loadedPlan.sha256,
        acceptanceSha256: loadedAcceptance.sha256,
    };
}
function loadDeltaAcceptance(path) {
    const loaded = privateJson(path);
    const value = loaded.value;
    if (value.schemaVersion !== 1
        || value.phase !== "clawlore-v2-live-v1-append-delta-acceptance"
        || value.status !== "pass"
        || !hasDigest(value.planDigest)
        || !Number.isFinite(Date.parse(value.verifiedAt))
        || value.source.sourceLogicalDigestUnchanged !== true
        || value.delta.rows <= 0
        || value.delta.rows !== value.delta.reflectionSummaryRows + value.delta.operationalCheckpointRows
        || value.delta.candidateRows !== value.delta.rows
        || value.delta.unverifiedRows !== value.delta.rows
        || value.delta.legacyIdentityDebtRows !== value.delta.rows
        || value.preserved.existingCanonicalRowsChanged !== 0
        || value.preserved.existingLifecycleRowsChanged !== 0
        || value.preserved.existingVerificationRowsChanged !== 0
        || value.preserved.existingEvidenceRowsChanged !== 0
        || value.lifecycle.candidateRows < value.delta.rows
        || value.projections.compatibilityRows !== value.source.v2Rows
        || value.projections.ftsRows !== value.source.v2Rows
        || value.projections.vectorRows !== value.source.v2Rows
        || value.projections.relationRows !== value.source.v2Rows
        || value.projections.newProcessedOutboxRows !== value.delta.rows * 3
        || value.projections.pendingOutboxRows !== 0
        || value.database.integrity !== "ok"
        || value.database.foreignKeyViolations !== 0
        || value.database.v1DoctorHealthy !== true
        || value.database.sqlVectorScopeMatch !== true
        || value.runtime.v1FallbackReads !== true
        || value.runtime.existingCandidateLifecycleMutationEnabled !== false
        || value.runtime.contextEngineEnabled !== false
        || value.runtime.promptMutationEnabled !== false
        || value.runtime.finalRecallCutoverEnabled !== false)
        throw new Error("delta acceptance contract is invalid or unsafe");
    return loaded;
}
function stableStateDigest(row) {
    return hash(JSON.stringify({
        itemId: row.item_id,
        currentRevisionId: row.current_revision_id,
        addressJson: row.address_json,
        lifecycle: row.lifecycle,
        verification: row.verification,
    }));
}
function classification(value) {
    return [
        "explicit_manual", "reflection_summary", "task_experience",
        "operational_checkpoint", "auto_capture", "unknown_legacy",
    ].includes(String(value)) ? value : "unknown_legacy";
}
function exactRegistryEvidence(value, plan, row) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("planned registry-resolved evidence is missing");
    }
    const evidence = value;
    const expectedKeys = [
        "assignedAt", "currentStateDigest", "evidenceKind", "planDigest", "preservesLifecycle",
        "preservesVerification", "proposedEvidencePayloadDigest", "resolver", "resolverEvidenceDigest",
        "rolloutId", "schemaVersion",
    ].sort();
    if (JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(expectedKeys)) {
        throw new Error("registry-resolved evidence shape is invalid");
    }
    const expectedKind = row.decision === "propose_private_principal_evidence_assignment"
        ? "direct-principal"
        : "conversation-boundary";
    if (evidence.schemaVersion !== 1
        || evidence.rolloutId !== plan.proposedRolloutId
        || evidence.planDigest !== plan.planDigest
        || evidence.evidenceKind !== expectedKind
        || evidence.resolver !== row.resolver
        || evidence.resolverEvidenceDigest !== row.resolverEvidenceDigest
        || evidence.currentStateDigest !== row.currentStateDigest
        || evidence.proposedEvidencePayloadDigest !== row.proposedEvidencePayloadDigest
        || evidence.preservesLifecycle !== true
        || evidence.preservesVerification !== true
        || !Number.isFinite(Date.parse(String(evidence.assignedAt ?? ""))))
        throw new Error("registry-resolved evidence does not match the bounded plan");
    return evidence;
}
function reviewRow(row, source, registryEvidence) {
    const address = JSON.parse(row.address_json);
    const kind = classification(source.classification);
    let attribution = "none";
    const evidence = { sourceReceiptCount: 0 };
    if (registryEvidence?.evidenceKind === "direct-principal") {
        attribution = "registry_direct";
        evidence.identityEvidenceDigest = registryEvidence.resolverEvidenceDigest;
    }
    else if (registryEvidence?.evidenceKind === "conversation-boundary") {
        attribution = "registry_conversation";
        evidence.boundaryEvidenceDigest = registryEvidence.resolverEvidenceDigest;
    }
    else if (kind === "unknown_legacy") {
        attribution = "opaque";
    }
    else if (address.visibility === "private" && address.principalId !== "legacy:unresolved") {
        attribution = "runtime_principal";
        evidence.identityEvidenceDigest = hash(JSON.stringify({
            principalId: address.principalId,
            platform: address.platform ?? "",
            accountId: address.accountId ?? "",
        }));
        evidence.resolvedPrincipalId = address.principalId;
    }
    return {
        itemId: row.item_id,
        lifecycle: row.lifecycle,
        verification: row.verification,
        classification: kind,
        attribution,
        address,
        evidence,
    };
}
function scalar(db, sql) {
    const row = db.prepare(sql).get();
    return Number(Object.values(row)[0] ?? 0);
}
function liveSourceSummary(db, includeDeltaProjections = false) {
    const summary = {
        v1Rows: scalar(db, "SELECT COUNT(*) FROM memory_truth"),
        v2Rows: scalar(db, "SELECT COUNT(*) FROM memory_items"),
        candidateRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'"),
        activeRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
        archivedRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'"),
        compatibilityRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2"),
        pendingOutboxRows: scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
    };
    if (includeDeltaProjections) {
        summary.currentFtsRows = scalar(db, "SELECT COUNT(*) FROM memory_fts_v2");
        summary.vectorRows = scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2");
        summary.relationRows = scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2");
    }
    return summary;
}
function candidateStateDigest(rows) {
    return hash(JSON.stringify(rows.map((row) => ({
        itemId: row.item_id,
        currentRevisionId: row.current_revision_id,
        addressJson: row.address_json,
        lifecycle: row.lifecycle,
        verification: row.verification,
        sourceId: row.source_id,
        evidenceJson: row.evidence_json,
    }))));
}
function candidateBaselineMatches(live, baseline, delta) {
    if (delta) {
        return live.v1Rows === delta.source.v1Rows
            && live.v2Rows === delta.source.v2Rows
            && live.candidateRows === delta.lifecycle.candidateRows
            && live.activeRows === delta.lifecycle.activeRows
            && live.archivedRows === delta.lifecycle.archivedRows
            && live.compatibilityRows === delta.projections.compatibilityRows
            && live.pendingOutboxRows === delta.projections.pendingOutboxRows
            && live.v2Rows === baseline.v2Rows + delta.delta.rows
            && live.candidateRows === baseline.candidateRows + delta.delta.candidateRows
            && live.activeRows === baseline.activeRows
            && live.archivedRows === baseline.archivedRows;
    }
    return live.v1Rows >= baseline.v1Rows
        && live.v2Rows === baseline.v2Rows
        && live.candidateRows === baseline.candidateRows
        && live.activeRows === baseline.activeRows
        && live.archivedRows === baseline.archivedRows
        && live.compatibilityRows === baseline.compatibilityRows
        && live.pendingOutboxRows === baseline.pendingOutboxRows;
}
export function createLivePostAssignmentCandidatePlanV1(input) {
    if (!/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(input.proposedRolloutId)) {
        throw new Error("proposed candidate rollout id is invalid");
    }
    const controls = loadControls(input.assignmentPlanPath, input.assignmentAcceptancePath);
    const priorControls = (input.priorAssignmentControls ?? []).map((control) => loadControls(control.planPath, control.acceptancePath));
    const assignmentControls = [controls, ...priorControls];
    const deltaControl = input.deltaAcceptancePath
        ? loadDeltaAcceptance(input.deltaAcceptancePath)
        : undefined;
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    let summary;
    let rows;
    let promotion;
    let directPrincipalRows = 0;
    let conversationBoundaryRows = 0;
    let unmirroredV1Rows = 0;
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        summary = liveSourceSummary(db, Boolean(deltaControl));
        unmirroredV1Rows = scalar(db, `SELECT COUNT(*) FROM memory_truth l
      LEFT JOIN memory_items i ON i.item_id='legacy:' || l.id WHERE i.item_id IS NULL`);
        const missingLegacyRowsForV2 = scalar(db, `SELECT COUNT(*) FROM memory_items i
      LEFT JOIN memory_truth l ON i.item_id='legacy:' || l.id WHERE l.id IS NULL`);
        rows = db.prepare(`SELECT i.item_id,i.current_revision_id,i.address_json,i.lifecycle,i.verification,
      s.source_id,s.evidence_json FROM memory_items i JOIN memory_sources s
      ON s.revision_id=i.current_revision_id WHERE i.lifecycle='candidate'
      ORDER BY i.item_id,s.source_id`).all();
        const beforeDigest = candidateStateDigest(rows);
        const planned = new Map(controls.plan.rows.map((row) => [row.itemIdSha256, row]));
        const acceptedTargets = new Map();
        for (const accepted of assignmentControls) {
            for (const row of accepted.plan.rows) {
                if (!row.decision.startsWith("propose_"))
                    continue;
                if (acceptedTargets.has(row.itemIdSha256)) {
                    throw new Error("assignment control chain contains an overlapping target");
                }
                if (!planned.has(row.itemIdSha256)) {
                    throw new Error("prior assignment target is outside the current candidate baseline");
                }
                acceptedTargets.set(row.itemIdSha256, { controls: accepted, row });
            }
        }
        if (!candidateBaselineMatches(summary, controls.plan.source, deltaControl?.value)
            || (deltaControl && (summary.currentFtsRows !== deltaControl.value.projections.ftsRows
                || summary.vectorRows !== deltaControl.value.projections.vectorRows
                || summary.relationRows !== deltaControl.value.projections.relationRows))
            || missingLegacyRowsForV2 !== 0
            || planned.size !== controls.plan.source.candidateRows
            || rows.length !== controls.plan.source.candidateRows + (deltaControl?.value.delta.rows ?? 0)
            || [...planned.keys()].some((itemIdSha256) => !rows.some((row) => hash(row.item_id) === itemIdSha256)))
            throw new Error("live candidate set no longer matches the evidence-assignment baseline");
        let deltaReflectionSummaryRows = 0;
        let deltaOperationalCheckpointRows = 0;
        let deltaUnverifiedRows = 0;
        let deltaLegacyIdentityDebtRows = 0;
        const reviewRows = rows.map((row) => {
            const plannedRow = planned.get(hash(row.item_id));
            if (plannedRow && plannedRow.currentStateDigest !== stableStateDigest(row)) {
                throw new Error("live candidate state no longer matches the evidence-assignment baseline");
            }
            const source = parseRecord(row.evidence_json);
            const assigned = source.registryResolvedEvidenceV1;
            if (!plannedRow) {
                const delta = deltaControl?.value;
                const address = JSON.parse(row.address_json);
                const kind = classification(source.classification);
                if (!delta
                    || assigned !== undefined
                    || !["reflection_summary", "operational_checkpoint"].includes(kind)
                    || row.verification !== "unverified"
                    || address.principalId !== "legacy:unresolved"
                    || source.verificationDebt !== "legacy_identity"
                    || source.reviewRequired !== true)
                    throw new Error("delta candidate state does not match the accepted append-only rollout");
                if (kind === "reflection_summary")
                    deltaReflectionSummaryRows += 1;
                else
                    deltaOperationalCheckpointRows += 1;
                deltaUnverifiedRows += 1;
                deltaLegacyIdentityDebtRows += 1;
                return reviewRow(row, source);
            }
            let registryEvidence;
            const acceptedTarget = acceptedTargets.get(hash(row.item_id));
            if (assigned !== undefined) {
                if (!acceptedTarget)
                    throw new Error("unplanned registry-resolved evidence exists");
                registryEvidence = exactRegistryEvidence(assigned, acceptedTarget.controls.plan, acceptedTarget.row);
                if (registryEvidence.evidenceKind === "direct-principal")
                    directPrincipalRows += 1;
                else
                    conversationBoundaryRows += 1;
            }
            return reviewRow(row, source, registryEvidence);
        });
        if (deltaControl && (deltaReflectionSummaryRows !== deltaControl.value.delta.reflectionSummaryRows
            || deltaOperationalCheckpointRows !== deltaControl.value.delta.operationalCheckpointRows
            || deltaUnverifiedRows !== deltaControl.value.delta.unverifiedRows
            || deltaLegacyIdentityDebtRows !== deltaControl.value.delta.legacyIdentityDebtRows))
            throw new Error("delta candidate counts do not match acceptance");
        if (directPrincipalRows !== assignmentControls.reduce((total, accepted) => total + accepted.acceptance.evidence.directPrincipalRows, 0)
            || conversationBoundaryRows !== assignmentControls.reduce((total, accepted) => total + accepted.acceptance.evidence.conversationBoundaryRows, 0)
            || directPrincipalRows + conversationBoundaryRows !== assignmentControls.reduce((total, accepted) => total + accepted.acceptance.evidence.rowsWritten, 0))
            throw new Error("validated evidence-assignment counts do not match acceptance");
        promotion = planCandidatePromotionsV1(reviewRows);
        const afterRows = db.prepare(`SELECT i.item_id,i.current_revision_id,i.address_json,i.lifecycle,i.verification,
      s.source_id,s.evidence_json FROM memory_items i JOIN memory_sources s
      ON s.revision_id=i.current_revision_id WHERE i.lifecycle='candidate'
      ORDER BY i.item_id,s.source_id`).all();
        if (beforeDigest !== candidateStateDigest(afterRows)
            || JSON.stringify(summary) !== JSON.stringify(liveSourceSummary(db, Boolean(deltaControl)))
            || unmirroredV1Rows !== scalar(db, `SELECT COUNT(*) FROM memory_truth l
        LEFT JOIN memory_items i ON i.item_id='legacy:' || l.id WHERE i.item_id IS NULL`))
            throw new Error("live candidate state changed during query-only planning");
    }
    finally {
        db.close();
    }
    const eligibleRows = promotion.counts.eligible_for_promotion;
    return {
        schemaVersion: 1,
        phase: "clawlore-post-assignment-candidate-plan",
        createdAt: (input.now?.() ?? new Date()).toISOString(),
        proposedRolloutId: input.proposedRolloutId,
        readOnly: true,
        queryOnly: true,
        emitsMemoryContent: false,
        emitsTranscriptContent: false,
        emitsRawIdentifiers: false,
        assignment: {
            rolloutId: controls.acceptance.rolloutId,
            planDigest: controls.plan.planDigest,
            planSha256: controls.planSha256,
            acceptanceSha256: controls.acceptanceSha256,
            controlRollouts: assignmentControls.map((accepted) => ({
                rolloutId: accepted.acceptance.rolloutId,
                planDigest: accepted.plan.planDigest,
                planSha256: accepted.planSha256,
                acceptanceSha256: accepted.acceptanceSha256,
                rowsValidated: accepted.acceptance.evidence.rowsWritten,
                directPrincipalRows: accepted.acceptance.evidence.directPrincipalRows,
                conversationBoundaryRows: accepted.acceptance.evidence.conversationBoundaryRows,
            })),
            rowsValidated: directPrincipalRows + conversationBoundaryRows,
            directPrincipalRows,
            conversationBoundaryRows,
            invalidEvidenceRows: 0,
            unplannedEvidenceRows: 0,
        },
        ...(deltaControl ? {
            delta: {
                rolloutId: deltaControl.value.rolloutId,
                planDigest: deltaControl.value.planDigest,
                acceptanceSha256: deltaControl.sha256,
                rowsValidated: deltaControl.value.delta.rows,
                reflectionSummaryRows: deltaControl.value.delta.reflectionSummaryRows,
                operationalCheckpointRows: deltaControl.value.delta.operationalCheckpointRows,
                candidateRows: deltaControl.value.delta.candidateRows,
                unverifiedRows: deltaControl.value.delta.unverifiedRows,
                legacyIdentityDebtRows: deltaControl.value.delta.legacyIdentityDebtRows,
                existingCanonicalRowsChanged: 0,
                existingLifecycleRowsChanged: 0,
                existingVerificationRowsChanged: 0,
                existingEvidenceRowsChanged: 0,
            },
        } : {}),
        source: {
            ...summary,
            baselineV1Rows: controls.plan.source.v1Rows,
            unmirroredV1Rows,
            missingLegacyRowsForV2: 0,
            candidateBaselineUnchanged: true,
            sourceUnchangedDuringPlan: true,
        },
        candidatePromotionPlan: promotion,
        decision: {
            eligibleRows,
            lifecycleRolloutSelectable: eligibleRows > 0,
            finalRecallCutoverBlockedByUnmirroredV1: unmirroredV1Rows > 0,
            automaticPromotionRows: 0,
        },
        authorizesLifecycleMutation: false,
        authorizesContextEngine: false,
        authorizesPromptMutation: false,
        authorizesFinalRecall: false,
        liveMutation: {
            evidenceRowsChanged: 0,
            lifecycleRowsChanged: 0,
            verificationRowsChanged: 0,
            addressRowsChanged: 0,
            contextEngineEnabled: false,
            promptMutationEnabled: false,
            finalRecallCutoverEnabled: false,
        },
    };
}
