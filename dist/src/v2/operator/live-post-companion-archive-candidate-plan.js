import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { companionDispositionSourceStateV1, sameCompanionDispositionSourceV1, validateLiveCandidateCompanionDispositionPlanV1, } from "./live-candidate-companion-disposition.js";
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
        throw new Error("post-archive candidate control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("post-archive candidate control JSON is invalid");
    }
    return { value, sha256: hash(bytes) };
}
function sourceMatches(left, right) {
    return sameCompanionDispositionSourceV1(left, right);
}
function validatePriorBaseline(value) {
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
        || promotion.rows.some((row) => !hasDigest(row.itemIdSha256))
        || Object.values(promotion.counts).reduce((total, count) => total + count, 0) !== promotion.rows.length
        || value.decision.eligibleRows !== 0
        || value.decision.lifecycleRolloutSelectable !== false
        || value.decision.automaticPromotionRows !== 0)
        throw new Error("prior candidate baseline is invalid or mutation-capable");
}
function validateApply(value, plan, planSha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-companion-soft-archive-live-apply"
        || value.status !== "applied"
        || value.planDigest !== plan.planDigest
        || value.planSha256 !== planSha256
        || value.archive.targetRows !== 3
        || value.archive.candidateRowsArchived !== 3
        || value.archive.currentContentRowsChanged !== 0
        || value.archive.currentVerificationRowsChanged !== 0
        || value.archive.addressRowsChanged !== 0
        || value.archive.aclRowsChanged !== 0
        || value.archive.nonTargetRowsChanged !== 0
        || Object.values(value.projections).some((count) => count !== 0)
        || value.database.integrity !== "ok"
        || value.database.foreignKeyViolations !== 0
        || value.runtime.contextEngineEnabled !== false
        || value.runtime.promptMutationEnabled !== false
        || value.runtime.finalRecallCutoverEnabled !== false)
        throw new Error("companion archive apply control is invalid");
}
function validatePostcheck(value, plan, apply, planSha256, applySha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-companion-soft-archive-postcheck"
        || value.status !== "pass"
        || value.rolloutId !== apply.rolloutId
        || value.planDigest !== plan.planDigest
        || value.planSha256 !== planSha256
        || value.applyReceiptSha256 !== applySha256
        || !sourceMatches(value.source, apply.sourceAfter)
        || value.targetBinding.archivedCompanionRows !== 3
        || value.targetBinding.preservedRepresentativeRows !== 3
        || value.targetBinding.validDispositionReceiptRows !== 3
        || value.targetBinding.supersedesRelationRows !== 3
        || value.targetBinding.archivedEventRows !== 3
        || value.targetBinding.projectionBindingRows !== 3
        || value.targetBinding.mismatches !== 0
        || value.database.integrity !== "ok"
        || value.database.foreignKeyViolations !== 0)
        throw new Error("companion archive postcheck control is invalid or unbound");
}
function promotionCounts(rows) {
    return {
        eligible_for_promotion: rows.filter((row) => row.disposition === "eligible_for_promotion").length,
        hold_candidate: rows.filter((row) => row.disposition === "hold_candidate").length,
        quarantine: rows.filter((row) => row.disposition === "quarantine").length,
        preserve_archived: rows.filter((row) => row.disposition === "preserve_archived").length,
    };
}
export function createLivePostCompanionArchiveCandidatePlanV1(input) {
    if (!/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(input.proposedRolloutId)) {
        throw new Error("post-archive candidate rollout id is invalid");
    }
    const loadedBaseline = privateJson(input.priorBaselinePath);
    validatePriorBaseline(loadedBaseline.value);
    const loadedPlan = privateJson(input.companionPlanPath);
    const plan = validateLiveCandidateCompanionDispositionPlanV1(loadedPlan.value, input.planDigest);
    const loadedApply = privateJson(input.applyReceiptPath);
    validateApply(loadedApply.value, plan, loadedPlan.sha256);
    const loadedPostcheck = privateJson(input.postcheckPath);
    validatePostcheck(loadedPostcheck.value, plan, loadedApply.value, loadedPlan.sha256, loadedApply.sha256);
    if (!sourceMatches(loadedBaseline.value.source, loadedApply.value.sourceBefore)) {
        throw new Error("prior candidate baseline does not match the companion archive pre-state");
    }
    const removed = [...new Set(plan.rows.map((row) => row.companionItemIdSha256))].sort();
    if (removed.length !== 3)
        throw new Error("companion archive target hashes are not exact");
    const priorByHash = new Map(loadedBaseline.value.candidatePromotionPlan.rows.map((row) => [row.itemIdSha256, row]));
    if (removed.some((itemIdSha256) => priorByHash.get(itemIdSha256)?.disposition !== "hold_candidate")) {
        throw new Error("companion archive target is outside the prior hold-candidate baseline");
    }
    const rows = loadedBaseline.value.candidatePromotionPlan.rows
        .filter((row) => !removed.includes(row.itemIdSha256));
    const counts = promotionCounts(rows);
    if (rows.length !== loadedPostcheck.value.source.candidateRows
        || counts.eligible_for_promotion !== 0
        || counts.preserve_archived !== 0)
        throw new Error("post-archive candidate policy counts are invalid");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const before = companionDispositionSourceStateV1(db);
        if (!sourceMatches(before, loadedPostcheck.value.source)) {
            throw new Error("live source no longer matches companion archive postcheck");
        }
        const liveRows = db.prepare("SELECT item_id FROM memory_items WHERE lifecycle='candidate' ORDER BY item_id").all();
        const liveHashes = liveRows.map((row) => hash(row.item_id)).sort();
        const plannedHashes = rows.map((row) => row.itemIdSha256).sort();
        if (JSON.stringify(liveHashes) !== JSON.stringify(plannedHashes)) {
            throw new Error("live candidate set does not match the rebased policy rows");
        }
        const after = companionDispositionSourceStateV1(db);
        if (!sourceMatches(before, after))
            throw new Error("live source changed during query-only candidate rebase");
    }
    finally {
        db.close();
    }
    const candidatePromotionPlan = {
        ...loadedBaseline.value.candidatePromotionPlan,
        counts,
        rows,
        planDigest: hash(JSON.stringify(rows)),
    };
    return {
        ...loadedBaseline.value,
        createdAt: (input.now ?? (() => new Date()))().toISOString(),
        proposedRolloutId: input.proposedRolloutId,
        source: {
            ...loadedBaseline.value.source,
            ...loadedPostcheck.value.source,
            candidateBaselineUnchanged: true,
            sourceUnchangedDuringPlan: true,
        },
        candidatePromotionPlan,
        archiveRebase: {
            rolloutId: loadedApply.value.rolloutId,
            planDigest: plan.planDigest,
            companionPlanSha256: loadedPlan.sha256,
            applyReceiptSha256: loadedApply.sha256,
            postcheckSha256: loadedPostcheck.sha256,
            priorBaselineSha256: loadedBaseline.sha256,
            archivedCandidateRows: 3,
            preservedCandidateRows: rows.length,
            removedItemIdSha256: removed,
        },
        decision: {
            ...loadedBaseline.value.decision,
            eligibleRows: 0,
            lifecycleRolloutSelectable: false,
            automaticPromotionRows: 0,
        },
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
