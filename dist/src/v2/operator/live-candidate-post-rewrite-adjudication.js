import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { normalizeCandidateContentV1, validateSourceLineageReceiptV1, } from "../application/candidate-content-quality-review.js";
import { adjudicateCandidatePostRewriteReviewV1, } from "../application/candidate-post-rewrite-adjudication.js";
import { validateLiveCandidateUnsafeTraceRewriteProposalPlanV1, } from "./live-candidate-unsafe-trace-rewrite-proposal.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const EXPECTED_QUALITY_ROWS = 90;
const EXPECTED_REWRITE_ROWS = 32;
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
        throw new Error("post-rewrite adjudication control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("post-rewrite adjudication control JSON is invalid");
    }
    return { value, sha256: hash(bytes) };
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
function contentCore(value) {
    return {
        proposedReviewId: value.proposedReviewId,
        remediationPlanDigest: value.remediationPlanDigest,
        remediationPreviewSha256: value.remediationPreviewSha256,
        source: value.source,
        counts: value.counts,
        summary: value.summary,
        rows: value.rows,
    };
}
function validateContentQuality(value) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-content-quality-review-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.emitsContentDigests !== true
        || value.automaticReviewRows !== 0
        || value.authorizesContentRewrite !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesHardDelete !== false
        || value.authorizesLifecycleMutation !== false
        || value.authorizesVerificationMutation !== false
        || value.authorizesContextEngine !== false
        || value.authorizesPromptMutation !== false
        || value.authorizesFinalRecall !== false
        || value.requiresOperatorSemanticReview !== true
        || value.rows?.length !== EXPECTED_QUALITY_ROWS
        || value.counts.capture_safety_reject_review !== 0
        || value.counts.oversized_content_review !== 0
        || value.counts.exact_duplicate_review !== 2
        || value.counts.manual_semantic_review !== 88
        || new Set(value.rows.map((row) => row.itemIdSha256)).size !== EXPECTED_QUALITY_ROWS
        || !isDigest(value.planDigest)
        || hash(JSON.stringify(contentCore(value))) !== value.planDigest)
        throw new Error("post-rewrite content-quality control is invalid or stale");
}
function validateRewriteApply(value, plan, planSha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-unsafe-trace-rewrite-live-apply"
        || value.status !== "applied"
        || value.planDigest !== plan.planDigest
        || value.planSha256 !== planSha256
        || value.payloadDigest !== plan.rewritePayloadDigest
        || value.rewrite.targetRows !== EXPECTED_REWRITE_ROWS
        || value.rewrite.proposedOutputRows !== EXPECTED_REWRITE_ROWS
        || value.rewrite.newRevisionRows !== EXPECTED_REWRITE_ROWS
        || value.rewrite.oldRevisionRowsSuperseded !== EXPECTED_REWRITE_ROWS
        || value.rewrite.currentContentRowsChanged !== EXPECTED_REWRITE_ROWS
        || value.rewrite.currentLifecycleRowsChanged !== 0
        || value.rewrite.currentVerificationRowsChanged !== 0
        || value.rewrite.addressRowsChanged !== 0
        || value.rewrite.aclRowsChanged !== 0
        || value.rewrite.nonTargetRowsChanged !== 0
        || value.projections.currentFtsRowsChanged !== EXPECTED_REWRITE_ROWS
        || value.projections.compatibilityRowsChanged !== 0
        || value.projections.vectorRowsChanged !== 0
        || value.projections.relationProjectionRowsChanged !== 0
        || value.projections.pendingOutboxRowsChanged !== 0
        || value.database.integrity !== "ok"
        || value.database.foreignKeyViolations !== 0
        || value.runtime.contextEngineEnabled !== false
        || value.runtime.promptMutationEnabled !== false
        || value.runtime.finalRecallCutoverEnabled !== false)
        throw new Error("post-rewrite apply receipt is invalid or outside the exact lane");
}
function validateRewritePostcheck(value, plan, planSha256, apply, applySha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-unsafe-trace-rewrite-postcheck"
        || value.status !== "pass"
        || value.rolloutId !== apply.rolloutId
        || value.planDigest !== plan.planDigest
        || value.planSha256 !== planSha256
        || value.applyReceiptSha256 !== applySha256
        || value.targetBinding.rewrittenRows !== EXPECTED_REWRITE_ROWS
        || value.targetBinding.validRewriteReceiptRows !== EXPECTED_REWRITE_ROWS
        || value.targetBinding.mismatches !== 0
        || value.database.integrity !== "ok"
        || value.database.foreignKeyViolations !== 0
        || value.runtime.contextEngineEnabled !== false
        || value.runtime.promptMutationEnabled !== false
        || value.runtime.finalRecallCutoverEnabled !== false)
        throw new Error("post-rewrite postcheck is invalid or unbound");
}
function decisionCore(value) {
    return {
        contentQualityPlanDigest: value.contentQualityPlanDigest,
        contentQualityPreviewSha256: value.contentQualityPreviewSha256,
        rewritePlanDigest: value.rewritePlanDigest,
        rewritePlanSha256: value.rewritePlanSha256,
        rewriteApplyReceiptSha256: value.rewriteApplyReceiptSha256,
        rewritePostcheckSha256: value.rewritePostcheckSha256,
        decisions: value.decisions,
    };
}
function validateDecisions(value, content, rewrite, applySha256, postcheckSha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-post-rewrite-operator-decisions"
        || value.readOnly !== true
        || value.containsMemoryContent !== false
        || value.containsRawIdentifiers !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesContentRewrite !== false
        || value.authorizesLifecycleMutation !== false
        || value.authorizesVerificationMutation !== false
        || value.contentQualityPlanDigest !== content.value.planDigest
        || value.contentQualityPreviewSha256 !== content.sha256
        || value.rewritePlanDigest !== rewrite.value.planDigest
        || value.rewritePlanSha256 !== rewrite.sha256
        || value.rewriteApplyReceiptSha256 !== applySha256
        || value.rewritePostcheckSha256 !== postcheckSha256
        || value.decisions?.length !== 58
        || !isDigest(value.decisionDigest)
        || hash(JSON.stringify(decisionCore(value))) !== value.decisionDigest)
        throw new Error("post-rewrite operator decision control is invalid or unbound");
}
function classification(metadata, evidence) {
    const explicit = String(evidence.classification ?? "").trim();
    if (explicit)
        return explicit;
    const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
    if (source.includes("manual") || source.includes("user"))
        return "explicit_manual";
    if (source.includes("reflection") || source.includes("summary") || source.includes("digest"))
        return "reflection_summary";
    if (source.includes("task") && source.includes("experience"))
        return "task_experience";
    if (source.includes("checkpoint") || source.includes("pressure"))
        return "operational_checkpoint";
    if (source.includes("capture"))
        return "auto_capture";
    return "unknown_legacy";
}
function assertLiveMatchesQuality(row, planned) {
    const metadata = parseRecord(row.metadata);
    const evidence = parseRecord(row.evidence_json);
    const lineage = evidence.sourceLineageReceiptV1;
    if (row.lifecycle !== "candidate"
        || row.verification !== "unverified"
        || hash(row.item_id) !== planned.itemIdSha256
        || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
        || hash(row.content) !== planned.contentDigest
        || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
        || row.category !== planned.category
        || !validateSourceLineageReceiptV1(lineage, classification(metadata, evidence))
        || hash(JSON.stringify(lineage)) !== planned.sourceLineageReceiptDigest)
        throw new Error("post-rewrite live candidate no longer matches the content-quality control");
}
function validRewriteReceipt(row, quality, planned, rolloutId, planDigest, payloadDigest) {
    const receipt = parseRecord(row.evidence_json).unsafeTraceRewriteReceiptV1;
    const output = planned.outputs[0];
    return planned.outputs.length === 1
        && quality.lane === "manual_semantic_review"
        && quality.captureSafety.allowed === true
        && hash(row.current_revision_id) !== planned.currentRevisionIdSha256
        && hash(row.content) === output.proposedContentDigest
        && hash(normalizeCandidateContentV1(row.content)) === output.proposedNormalizedContentDigest
        && receipt?.schemaVersion === 1
        && receipt.rolloutId === rolloutId
        && receipt.planDigest === planDigest
        && receipt.payloadDigest === payloadDigest
        && receipt.previousContentDigest === planned.contentDigest
        && receipt.rewrittenContentDigest === output.proposedContentDigest
        && receipt.sourceLineageReceiptDigest === planned.sourceLineageReceiptDigest
        && receipt.preservesCurrentLifecycle === true
        && receipt.preservesVerification === true
        && receipt.preservesAddress === true;
}
export function createLiveCandidatePostRewriteAdjudicationPlanV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedAdjudicationId)) {
        throw new Error("post-rewrite adjudication id is invalid");
    }
    const content = privateJson(input.contentQualityPreviewPath);
    validateContentQuality(content.value);
    const rewrite = privateJson(input.rewritePlanPath);
    validateLiveCandidateUnsafeTraceRewriteProposalPlanV1(rewrite.value);
    if (rewrite.value.rows.some((row) => row.outputs.length !== 1)) {
        throw new Error("post-rewrite closure requires exact one-output materialization per target");
    }
    const apply = privateJson(input.rewriteApplyReceiptPath);
    validateRewriteApply(apply.value, rewrite.value, rewrite.sha256);
    const postcheck = privateJson(input.rewritePostcheckPath);
    validateRewritePostcheck(postcheck.value, rewrite.value, rewrite.sha256, apply.value, apply.sha256);
    if (!sameSource(content.value.source, postcheck.value.source)) {
        throw new Error("post-rewrite content-quality source does not match the independent postcheck");
    }
    const decisions = privateJson(input.decisionControlPath);
    validateDecisions(decisions.value, content, rewrite, apply.sha256, postcheck.sha256);
    const qualityByHash = new Map(content.value.rows.map((row) => [row.itemIdSha256, row]));
    const rewriteByHash = new Map(rewrite.value.rows.map((row) => [row.itemIdSha256, row]));
    if (rewriteByHash.size !== EXPECTED_REWRITE_ROWS
        || [...rewriteByHash.keys()].some((itemHash) => !qualityByHash.has(itemHash)))
        throw new Error("post-rewrite closure targets are not an exact subset of content review");
    const remaining = content.value.rows.filter((row) => !rewriteByHash.has(row.itemIdSha256));
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const before = sourceState(db);
        if (!sameSource(before, content.value.source)) {
            throw new Error("live source no longer matches post-rewrite controls");
        }
        const candidates = db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,
      i.lifecycle,i.verification,l.metadata,
      COALESCE((SELECT s.evidence_json FROM memory_sources s
        WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
      FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all();
        if (candidates.length !== before.candidateRows) {
            throw new Error("post-rewrite candidate mapping is incomplete");
        }
        const liveByHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
        for (const quality of content.value.rows) {
            const live = liveByHash.get(quality.itemIdSha256);
            if (!live)
                throw new Error("post-rewrite content-quality target mapping is incomplete");
            assertLiveMatchesQuality(live, quality);
            const planned = rewriteByHash.get(quality.itemIdSha256);
            if (planned && !validRewriteReceipt(live, quality, planned, apply.value.rolloutId, rewrite.value.planDigest, rewrite.value.rewritePayloadDigest))
                throw new Error("post-rewrite target receipt or current content is invalid");
        }
        const adjudication = adjudicateCandidatePostRewriteReviewV1(remaining, decisions.value.decisions);
        const after = sourceState(db);
        if (!sameSource(before, after))
            throw new Error("live source changed during query-only post-rewrite adjudication");
        const core = {
            proposedAdjudicationId: input.proposedAdjudicationId,
            contentQualityPlanDigest: content.value.planDigest,
            contentQualityPreviewSha256: content.sha256,
            rewritePlanDigest: rewrite.value.planDigest,
            rewritePlanSha256: rewrite.sha256,
            rewriteApplyReceiptSha256: apply.sha256,
            rewritePostcheckSha256: postcheck.sha256,
            decisionControlDigest: decisions.value.decisionDigest,
            decisionControlSha256: decisions.sha256,
            source: before,
            rewriteClosure: {
                rewrittenRows: 32,
                validRewriteReceiptRows: 32,
                closedFromSemanticReviewRows: 32,
                mismatches: 0,
            },
            summary: adjudication.summary,
            rows: adjudication.rows,
        };
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-post-rewrite-adjudication-plan",
            createdAt: (input.now ?? (() => new Date()))().toISOString(),
            readOnly: true,
            queryOnly: true,
            emitsMemoryContent: false,
            emitsTranscriptContent: false,
            emitsRawIdentifiers: false,
            emitsContentDigests: true,
            mutationReadyRows: 0,
            authorizesContentRewrite: false,
            authorizesSoftArchive: false,
            authorizesHardDelete: false,
            authorizesLifecycleMutation: false,
            authorizesVerificationMutation: false,
            authorizesContextEngine: false,
            authorizesPromptMutation: false,
            authorizesFinalRecall: false,
            requiresSeparateExactApply: true,
            ...core,
            planDigest: hash(JSON.stringify(core)),
        };
    }
    finally {
        db.close();
    }
}
