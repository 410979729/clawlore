import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { companionDispositionSourceStateV1, sameCompanionDispositionSourceV1, } from "./live-candidate-companion-disposition.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function hasDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function privateJson(path) {
    if (process.platform === "win32")
        preparePrivateFileForRead(path);
    const info = statSync(path);
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
        throw new Error("post-append candidate control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("post-append candidate control JSON is invalid");
    }
    return { value, sha256: hash(bytes) };
}
function counts(rows) {
    return {
        eligible_for_promotion: rows.filter((row) => row.disposition === "eligible_for_promotion").length,
        hold_candidate: rows.filter((row) => row.disposition === "hold_candidate").length,
        quarantine: rows.filter((row) => row.disposition === "quarantine").length,
        preserve_archived: rows.filter((row) => row.disposition === "preserve_archived").length,
    };
}
function scalar(db, sql) {
    return Number(Object.values(db.prepare(sql).get())[0] ?? 0);
}
function parseRecord(value) {
    try {
        const parsed = JSON.parse(value || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function validatePrior(value) {
    const promotion = value?.candidatePromotionPlan;
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-post-assignment-candidate-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.authorizesLifecycleMutation !== false
        || value.authorizesContextEngine !== false
        || value.authorizesPromptMutation !== false
        || value.authorizesFinalRecall !== false
        || promotion?.schemaVersion !== 1
        || promotion.readOnly !== true
        || promotion.emitsItemIds !== false
        || promotion.authorizesLiveMutation !== false
        || promotion.automaticPromotionRows !== 0
        || !hasDigest(promotion.planDigest)
        || !Array.isArray(promotion.rows)
        || hash(JSON.stringify(promotion.rows)) !== promotion.planDigest
        || promotion.rows.length !== value.source.candidateRows
        || new Set(promotion.rows.map((row) => row.itemIdSha256)).size !== promotion.rows.length
        || value.decision.eligibleRows !== 0
        || value.decision.lifecycleRolloutSelectable !== false
        || value.decision.automaticPromotionRows !== 0)
        throw new Error("prior post-append candidate baseline is invalid or mutation-capable");
}
function validateControls(prior, priorSha256, plan, planSha256, apply, acceptance) {
    const reflectionRows = plan.proposed.classifications.reflection_summary ?? 0;
    const checkpointRows = plan.proposed.classifications.operational_checkpoint ?? 0;
    const supportedClassifications = Object.entries(plan.proposed.classifications)
        .filter(([, rows]) => rows !== 0)
        .every(([classification]) => classification === "reflection_summary"
        || classification === "operational_checkpoint");
    if (plan.schemaVersion !== 1
        || plan.phase !== "clawlore-v1-append-delta-plan"
        || plan.readOnly !== true
        || plan.queryOnly !== true
        || plan.emitsMemoryContent !== false
        || plan.emitsRawIdentifiers !== false
        || plan.baseline.receiptSha256 !== priorSha256
        || plan.baseline.candidatePlanDigest !== prior.candidatePromotionPlan.planDigest
        || plan.baseline.candidateRows !== prior.source.candidateRows
        || plan.source.v2Rows !== prior.source.v2Rows
        || plan.source.deltaRows <= 0
        || plan.proposed.rows.length !== plan.source.deltaRows
        || plan.proposed.candidateRows !== plan.source.deltaRows
        || plan.proposed.activeRows !== 0
        || plan.proposed.archivedRows !== 0
        || !supportedClassifications
        || reflectionRows + checkpointRows !== plan.source.deltaRows
        || plan.proposed.verifications.unverified !== plan.source.deltaRows
        || plan.proposed.verificationDebt.legacy_identity !== plan.source.deltaRows
        || plan.proposed.reviewRequiredRows !== plan.source.deltaRows
        || plan.proposed.invalidMetadataRows !== 0
        || plan.decision.deltaWriteReady !== true
        || plan.authorizesDeltaWrite !== false
        || apply.schemaVersion !== 1
        || apply.phase !== "clawlore-v2-live-v1-append-delta"
        || apply.status !== "applied"
        || apply.rolloutId !== plan.proposedRolloutId
        || apply.planDigest !== plan.proposed.planDigest
        || apply.planSha256 !== planSha256
        || apply.v2.beforeRows !== prior.source.v2Rows
        || apply.v2.afterRows !== prior.source.v2Rows + plan.source.deltaRows
        || apply.v2.deltaRows !== plan.source.deltaRows
        || apply.v2.activeRows !== prior.source.activeRows
        || apply.v2.candidateRows !== prior.source.candidateRows + plan.source.deltaRows
        || apply.v2.archivedRows !== prior.source.archivedRows
        || apply.v2.existingCanonicalRowsChanged !== 0
        || apply.v2.existingLifecycleRowsChanged !== 0
        || apply.v2.existingVerificationRowsChanged !== 0
        || apply.v2.existingEvidenceRowsChanged !== 0
        || apply.database.integrity !== "ok"
        || apply.database.foreignKeyViolations !== 0
        || acceptance.schemaVersion !== 1
        || acceptance.phase !== "clawlore-v2-live-v1-append-delta-acceptance"
        || acceptance.status !== "pass"
        || acceptance.rolloutId !== apply.rolloutId
        || acceptance.planDigest !== apply.planDigest
        || acceptance.delta.rows !== plan.source.deltaRows
        || acceptance.delta.reflectionSummaryRows !== reflectionRows
        || acceptance.delta.operationalCheckpointRows !== checkpointRows
        || acceptance.delta.candidateRows !== plan.source.deltaRows
        || acceptance.delta.unverifiedRows !== plan.source.deltaRows
        || acceptance.delta.legacyIdentityDebtRows !== plan.source.deltaRows
        || acceptance.preserved.existingCanonicalRowsChanged !== 0
        || acceptance.preserved.existingLifecycleRowsChanged !== 0
        || acceptance.preserved.existingVerificationRowsChanged !== 0
        || acceptance.preserved.existingEvidenceRowsChanged !== 0
        || acceptance.database.integrity !== "ok"
        || acceptance.database.foreignKeyViolations !== 0
        || acceptance.database.v1DoctorHealthy !== true
        || acceptance.database.sqlVectorScopeMatch !== true
        || acceptance.runtime.existingCandidateLifecycleMutationEnabled !== false
        || acceptance.runtime.contextEngineEnabled !== false
        || acceptance.runtime.promptMutationEnabled !== false
        || acceptance.runtime.finalRecallCutoverEnabled !== false)
        throw new Error("post-append candidate controls are invalid or not exact");
}
export function createLivePostV1AppendCandidatePlanV1(input) {
    if (!/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(input.proposedRolloutId)) {
        throw new Error("post-append candidate rollout id is invalid");
    }
    const loadedPrior = privateJson(input.priorBaselinePath);
    validatePrior(loadedPrior.value);
    const loadedPlan = privateJson(input.deltaPlanPath);
    const loadedApply = privateJson(input.applyReceiptPath);
    const loadedAcceptance = privateJson(input.acceptancePath);
    validateControls(loadedPrior.value, loadedPrior.sha256, loadedPlan.value, loadedPlan.sha256, loadedApply.value, loadedAcceptance.value);
    const priorHashes = new Set(loadedPrior.value.candidatePromotionPlan.rows.map((row) => row.itemIdSha256));
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    let source;
    let added;
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        source = companionDispositionSourceStateV1(db);
        const expected = {
            v1Rows: loadedAcceptance.value.source.v1Rows,
            v2Rows: loadedAcceptance.value.source.v2Rows,
            candidateRows: loadedAcceptance.value.lifecycle.candidateRows,
            activeRows: loadedAcceptance.value.lifecycle.activeRows,
            archivedRows: loadedAcceptance.value.lifecycle.archivedRows,
            compatibilityRows: loadedAcceptance.value.projections.compatibilityRows,
            currentFtsRows: loadedAcceptance.value.projections.ftsRows,
            vectorRows: loadedAcceptance.value.projections.vectorRows,
            relationRows: loadedAcceptance.value.projections.relationRows,
            pendingOutboxRows: loadedAcceptance.value.projections.pendingOutboxRows,
        };
        if (!sameCompanionDispositionSourceV1(source, expected)) {
            throw new Error("live source no longer matches the accepted append-only rollout");
        }
        const missingLegacyRowsForV2 = scalar(db, `SELECT COUNT(*) FROM memory_items i
      LEFT JOIN memory_truth l ON i.item_id='legacy:' || l.id WHERE l.id IS NULL`);
        const unmirroredV1Rows = scalar(db, `SELECT COUNT(*) FROM memory_truth l
      LEFT JOIN memory_items i ON i.item_id='legacy:' || l.id WHERE i.item_id IS NULL`);
        if (missingLegacyRowsForV2 !== 0 || unmirroredV1Rows !== 0) {
            throw new Error("post-append candidate source is not converged");
        }
        const rows = db.prepare(`SELECT i.item_id,i.content,i.lifecycle,i.verification,i.address_json,
      s.external_id,s.evidence_json
      FROM memory_items i JOIN memory_sources s ON s.revision_id=i.current_revision_id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id,s.source_id`).all();
        const liveHashes = rows.map((row) => hash(row.item_id));
        const uniqueLiveHashes = new Set(liveHashes);
        if (rows.length !== source.candidateRows || uniqueLiveHashes.size !== rows.length
            || [...priorHashes].some((itemIdSha256) => !uniqueLiveHashes.has(itemIdSha256))) {
            throw new Error("prior candidate set is not preserved after append");
        }
        const addedRows = rows.filter((row) => !priorHashes.has(hash(row.item_id)));
        if (addedRows.length !== loadedPlan.value.source.deltaRows) {
            throw new Error("append rebase is not the exact accepted delta lane");
        }
        const plannedByLegacyId = new Map(loadedPlan.value.proposed.rows
            .map((row) => [row.legacyIdSha256, row]));
        added = addedRows.map((row) => {
            const evidence = parseRecord(row.evidence_json);
            const address = parseRecord(row.address_json);
            const planned = plannedByLegacyId.get(hash(row.external_id));
            if (row.lifecycle !== "candidate" || row.verification !== "unverified"
                || !planned
                || hash(row.content) !== planned.contentSha256
                || hash(row.address_json) !== planned.addressSha256
                || evidence.classification !== planned.classification
                || evidence.verificationDebt !== "legacy_identity" || evidence.reviewRequired !== true
                || evidence.registryResolvedEvidenceV1 !== undefined || address.principalId !== "legacy:unresolved") {
                throw new Error("appended candidate is not the accepted conservative delta shape");
            }
            return {
                itemIdSha256: hash(row.item_id),
                disposition: "hold_candidate",
                reasonCodes: ["unresolved_principal", "private_identity_evidence_missing",
                    "identity_evidence_digest_missing", "principal_evidence_address_mismatch"],
            };
        });
        if (!sameCompanionDispositionSourceV1(source, companionDispositionSourceStateV1(db))) {
            throw new Error("live source changed during post-append candidate rebase");
        }
    }
    finally {
        db.close();
    }
    const rows = [...loadedPrior.value.candidatePromotionPlan.rows, ...added];
    const promotionCounts = counts(rows);
    if (rows.length !== source.candidateRows || promotionCounts.eligible_for_promotion !== 0
        || promotionCounts.preserve_archived !== 0)
        throw new Error("post-append candidate policy counts are invalid");
    return {
        ...loadedPrior.value,
        createdAt: (input.now ?? (() => new Date()))().toISOString(),
        proposedRolloutId: input.proposedRolloutId,
        delta: {
            rolloutId: loadedAcceptance.value.rolloutId,
            planDigest: loadedAcceptance.value.planDigest,
            acceptanceSha256: loadedAcceptance.sha256,
            rowsValidated: loadedAcceptance.value.delta.rows,
            reflectionSummaryRows: loadedAcceptance.value.delta.reflectionSummaryRows,
            operationalCheckpointRows: loadedAcceptance.value.delta.operationalCheckpointRows,
            candidateRows: loadedAcceptance.value.delta.candidateRows,
            unverifiedRows: loadedAcceptance.value.delta.unverifiedRows,
            legacyIdentityDebtRows: loadedAcceptance.value.delta.legacyIdentityDebtRows,
            existingCanonicalRowsChanged: 0,
            existingLifecycleRowsChanged: 0,
            existingVerificationRowsChanged: 0,
            existingEvidenceRowsChanged: 0,
        },
        source: { ...source, baselineV1Rows: loadedPrior.value.source.baselineV1Rows,
            unmirroredV1Rows: 0, missingLegacyRowsForV2: 0, candidateBaselineUnchanged: true,
            sourceUnchangedDuringPlan: true },
        candidatePromotionPlan: { ...loadedPrior.value.candidatePromotionPlan, counts: promotionCounts,
            rows, planDigest: hash(JSON.stringify(rows)) },
        decision: { ...loadedPrior.value.decision, eligibleRows: 0, lifecycleRolloutSelectable: false,
            finalRecallCutoverBlockedByUnmirroredV1: false, automaticPromotionRows: 0 },
        appendRebase: {
            rolloutId: loadedApply.value.rolloutId,
            planDigest: loadedApply.value.planDigest,
            deltaPlanSha256: loadedPlan.sha256,
            applyReceiptSha256: loadedApply.sha256,
            acceptanceSha256: loadedAcceptance.sha256,
            priorBaselineSha256: loadedPrior.sha256,
            appendedCandidateRows: added.length,
            preservedCandidateRows: loadedPrior.value.source.candidateRows,
            addedItemIdSha256: added.map((row) => row.itemIdSha256),
        },
    };
}
