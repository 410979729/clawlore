import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { decideClawLorePhase9CutoverV1, } from "../application/phase9-cutover-decision.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function privateJson(path) {
    if (process.platform === "win32")
        preparePrivateFileForRead(path);
    const info = statSync(path);
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
        throw new Error("Phase 9 input must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Phase 9 input JSON is invalid");
    return { value, sha256: hash(bytes) };
}
function scalar(db, sql) {
    const row = db.prepare(sql).get();
    return Number(Object.values(row)[0] ?? 0);
}
function sourceState(db) {
    return {
        v1Rows: scalar(db, "SELECT COUNT(*) FROM memory_truth"),
        v2Rows: scalar(db, "SELECT COUNT(*) FROM memory_items"),
        candidateRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate'"),
        activeRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
        archivedRows: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='archived'"),
        compatibilityRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2"),
        currentFtsRows: scalar(db, "SELECT COUNT(*) FROM memory_fts_v2"),
        vectorRows: scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2"),
        relationRows: scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2"),
        pendingOutboxRows: scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
    };
}
function sameSource(left, right) {
    return Object.keys(left).every((key) => left[key] === right[key]);
}
function validateBaseline(value) {
    const promotion = value?.candidatePromotionPlan;
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-post-assignment-candidate-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.source.unmirroredV1Rows !== 0
        || value.source.missingLegacyRowsForV2 !== 0
        || value.source.candidateBaselineUnchanged !== true
        || value.source.sourceUnchangedDuringPlan !== true
        || promotion?.schemaVersion !== 1
        || promotion.phase !== "clawlore-candidate-promotion-plan"
        || promotion.readOnly !== true
        || promotion.emitsItemIds !== false
        || promotion.automaticPromotionRows !== 0
        || promotion.authorizesLiveMutation !== false
        || promotion.rows?.length !== value.source.candidateRows
        || promotion.counts.eligible_for_promotion !== 0
        || new Set(promotion.rows.map((row) => row.itemIdSha256)).size !== promotion.rows.length
        || !isDigest(promotion.planDigest)
        || hash(JSON.stringify(promotion.rows)) !== promotion.planDigest
        || value.decision.eligibleRows !== 0
        || value.decision.lifecycleRolloutSelectable !== false
        || value.decision.automaticPromotionRows !== 0
        || value.authorizesLifecycleMutation !== false
        || value.authorizesContextEngine !== false
        || value.authorizesPromptMutation !== false
        || value.authorizesFinalRecall !== false)
        throw new Error("Phase 9 candidate baseline is invalid or mutation-capable");
}
function phase8gCore(value) {
    return {
        proposedAdjudicationId: value.proposedAdjudicationId,
        contentQualityPlanDigest: value.contentQualityPlanDigest,
        contentQualityPreviewSha256: value.contentQualityPreviewSha256,
        rewritePlanDigest: value.rewritePlanDigest,
        rewritePlanSha256: value.rewritePlanSha256,
        rewriteApplyReceiptSha256: value.rewriteApplyReceiptSha256,
        rewritePostcheckSha256: value.rewritePostcheckSha256,
        decisionControlDigest: value.decisionControlDigest,
        decisionControlSha256: value.decisionControlSha256,
        source: value.source,
        rewriteClosure: value.rewriteClosure,
        summary: value.summary,
        rows: value.rows,
    };
}
function validatePhase8g(value) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-post-rewrite-adjudication-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.emitsContentDigests !== true
        || value.mutationReadyRows !== 0
        || value.authorizesContentRewrite !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesHardDelete !== false
        || value.authorizesLifecycleMutation !== false
        || value.authorizesVerificationMutation !== false
        || value.authorizesContextEngine !== false
        || value.authorizesPromptMutation !== false
        || value.authorizesFinalRecall !== false
        || value.requiresSeparateExactApply !== true
        || value.rewriteClosure.rewrittenRows !== 32
        || value.rewriteClosure.validRewriteReceiptRows !== 32
        || value.rewriteClosure.closedFromSemanticReviewRows !== 32
        || value.rewriteClosure.mismatches !== 0
        || value.summary.targetRows !== 58
        || value.summary.exactDuplicateRows !== 2
        || value.summary.manualSemanticRows !== 56
        || value.summary.proposedSoftArchiveRows !== 24
        || value.summary.retainedForVerificationRows !== 34
        || value.summary.boundedRewriteHoldRows !== 0
        || value.summary.mutationReadyRows !== 0
        || value.rows?.length !== 58
        || !isDigest(value.planDigest)
        || hash(JSON.stringify(phase8gCore(value))) !== value.planDigest)
        throw new Error("Phase 9 adjudication control is invalid or mutation-capable");
}
function validateRewritePostcheck(value) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-unsafe-trace-rewrite-postcheck"
        || value.status !== "pass"
        || value.targetBinding.rewrittenRows !== 32
        || value.targetBinding.validRewriteReceiptRows !== 32
        || value.targetBinding.mismatches !== 0
        || value.database.integrity !== "ok"
        || value.database.foreignKeyViolations !== 0
        || value.runtime.v1FallbackReads !== true
        || value.runtime.contextEngineEnabled !== false
        || value.runtime.promptMutationEnabled !== false
        || value.runtime.finalRecallCutoverEnabled !== false)
        throw new Error("Phase 9 rewrite postcheck is invalid");
}
export function createLiveClawLorePhase9NoCutoverReceiptV1(input) {
    const baseline = privateJson(input.candidateBaselinePath);
    validateBaseline(baseline.value);
    const phase8g = privateJson(input.phase8gPlanPath);
    validatePhase8g(phase8g.value);
    const postcheck = privateJson(input.rewritePostcheckPath);
    validateRewritePostcheck(postcheck.value);
    const config = privateJson(input.configPath);
    const plugin = config.value.plugins?.entries?.["clawlore"];
    const clawlore = plugin?.config?.clawloreV2;
    if (plugin?.enabled !== true || clawlore?.mode !== "shadow" || clawlore.contextEngine !== "compatibility") {
        throw new Error("Phase 9 live configuration is not the expected read-only shadow boundary");
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const before = sourceState(db);
        if (!sameSource(before, baseline.value.source)
            || !sameSource(before, phase8g.value.source)
            || !sameSource(before, postcheck.value.source))
            throw new Error("Phase 9 live source no longer matches the accepted control chain");
        const candidateUnverifiedRows = scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='candidate' AND verification='unverified'");
        const activeInjectableRows = scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active' AND verification IN ('operator_reviewed','user_confirmed','tool_verified')");
        const currentContentDivergenceRows = scalar(db, "SELECT COUNT(*) FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id WHERE i.content<>l.text");
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        const after = sourceState(db);
        if (!sameSource(before, after))
            throw new Error("live source changed during query-only Phase 9 decision");
        const runtime = {
            configuredMode: "shadow",
            configuredContextEngine: "compatibility",
            cutoverModeImplemented: false,
            v1FallbackReads: true,
            contextEngineEnabled: false,
            promptMutationEnabled: false,
            finalRecallCutoverEnabled: false,
        };
        const phase8gSummary = {
            proposedSoftArchiveRows: phase8g.value.summary.proposedSoftArchiveRows,
            retainedForVerificationRows: phase8g.value.summary.retainedForVerificationRows,
            boundedRewriteHoldRows: phase8g.value.summary.boundedRewriteHoldRows,
            mutationReadyRows: 0,
        };
        const decision = decideClawLorePhase9CutoverV1({
            live: {
                candidateRows: before.candidateRows,
                candidateUnverifiedRows,
                activeRows: before.activeRows,
                activeInjectableRows,
                contentDivergenceRows: currentContentDivergenceRows,
                integrity: integrity === "ok" ? "ok" : "failed",
                foreignKeyViolations,
            },
            promotion: {
                eligibleRows: baseline.value.decision.eligibleRows,
                lifecycleRolloutSelectable: baseline.value.decision.lifecycleRolloutSelectable,
            },
            phase8g: phase8gSummary,
            runtime,
        });
        if (integrity !== "ok" || foreignKeyViolations !== 0) {
            throw new Error("Phase 9 database integrity check failed");
        }
        const source = {
            ...before,
            candidateUnverifiedRows,
            activeInjectableRows,
            currentContentDivergenceRows,
            integrity: "ok",
            foreignKeyViolations: 0,
            unchangedDuringDecision: true,
        };
        const core = {
            candidateBaselineSha256: baseline.sha256,
            candidatePromotionPlanDigest: baseline.value.candidatePromotionPlan.planDigest,
            phase8gPlanSha256: phase8g.sha256,
            phase8gPlanDigest: phase8g.value.planDigest,
            rewritePostcheckSha256: postcheck.sha256,
            configSha256: config.sha256,
            source,
            runtime,
            phase8g: phase8gSummary,
            decision,
        };
        return {
            schemaVersion: 1,
            phase: "clawlore-phase9-cutover-decision",
            decidedAt: (input.now ?? (() => new Date()))().toISOString(),
            readOnly: true,
            queryOnly: true,
            emitsMemoryContent: false,
            emitsRawIdentifiers: false,
            ...core,
            planDigest: hash(JSON.stringify(core)),
        };
    }
    finally {
        db.close();
    }
}
