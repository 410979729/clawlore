import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { digestCandidateCompanionDispositionV1, planCandidateCompanionDispositionV1, } from "../application/candidate-companion-disposition.js";
import { normalizeCandidateContentV1, validateSourceLineageReceiptV1, } from "../application/candidate-content-quality-review.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function privateJson(path) {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
        throw new Error("companion disposition control must be a non-empty owner-only JSON file");
    }
    const bytes = readFileSync(path);
    return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
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
    return Number(Object.values(db.prepare(sql).get())[0] ?? 0);
}
export function companionDispositionSourceStateV1(db) {
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
export function sameCompanionDispositionSourceV1(left, right) {
    return left.v1Rows === right.v1Rows
        && left.v2Rows === right.v2Rows
        && left.candidateRows === right.candidateRows
        && left.activeRows === right.activeRows
        && left.archivedRows === right.archivedRows
        && left.compatibilityRows === right.compatibilityRows
        && left.currentFtsRows === right.currentFtsRows
        && left.vectorRows === right.vectorRows
        && left.relationRows === right.relationRows
        && left.pendingOutboxRows === right.pendingOutboxRows;
}
function postcheckSource(value) {
    return {
        v1Rows: value.v1Rows,
        v2Rows: value.v2Rows,
        candidateRows: value.candidateRows,
        activeRows: value.activeRows,
        archivedRows: value.archivedRows,
        compatibilityRows: value.compatibilityRows,
        currentFtsRows: value.currentFtsRows,
        vectorRows: value.vectorRows,
        relationRows: value.relationProjectionRows,
        pendingOutboxRows: value.pendingOutboxRows,
    };
}
function validateDigestCore(plan, core, label) {
    if (!isDigest(plan.planDigest) || hash(JSON.stringify(core)) !== plan.planDigest) {
        throw new Error(`${label} digest is invalid`);
    }
}
function validateRewritePlan(value) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-durable-rewrite-proposal-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.containsProposedMemoryContent !== false
        || value.containsOriginalMemoryContent !== false
        || value.containsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.rewriteRepresentativeRows !== 3
        || value.postRewriteDedupeHoldRows !== 3
        || value.mutationReadyRows !== 0
        || value.authorizesSoftArchive !== false
        || value.authorizesLifecycleMutation !== false
        || value.summary.targetGroups !== 3
        || value.summary.targetRows !== 6
        || value.groups.length !== 3
        || value.rows.length !== 6)
        throw new Error("companion disposition rewrite plan is invalid");
    if (value.rows.filter((row) => row.role === "rewrite_representative").length !== 3
        || value.rows.filter((row) => row.role === "post_rewrite_dedupe_hold").length !== 3) {
        throw new Error("companion disposition rewrite roles are invalid");
    }
    validateDigestCore(value, {
        proposedRewriteId: value.proposedRewriteId,
        adjudicationPlanDigest: value.adjudicationPlanDigest,
        adjudicationPreviewSha256: value.adjudicationPreviewSha256,
        rewritePayloadDigest: value.rewritePayloadDigest,
        rewritePayloadSha256: value.rewritePayloadSha256,
        adjudicationSource: value.adjudicationSource,
        appendOnlySourceExtensionRows: value.appendOnlySourceExtensionRows,
        source: value.source,
        summary: value.summary,
        groups: value.groups,
        rows: value.rows,
    }, "companion disposition rewrite plan");
    return value;
}
function qualityCore(plan) {
    return {
        proposedReviewId: plan.proposedReviewId,
        remediationPlanDigest: plan.remediationPlanDigest,
        remediationPreviewSha256: plan.remediationPreviewSha256,
        source: plan.source,
        counts: plan.counts,
        summary: plan.summary,
        rows: plan.rows,
    };
}
function safetyCore(plan) {
    return {
        proposedReviewId: plan.proposedReviewId,
        contentQualityPlanDigest: plan.contentQualityPlanDigest,
        contentQualityPreviewSha256: plan.contentQualityPreviewSha256,
        source: plan.source,
        counts: plan.counts,
        summary: plan.summary,
        rows: plan.rows,
    };
}
function validateQuality(value) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-content-quality-review-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.emitsContentDigests !== true
        || value.authorizesSoftArchive !== false
        || value.authorizesLifecycleMutation !== false
        || !Array.isArray(value.rows))
        throw new Error("companion disposition content-quality control is invalid");
    validateDigestCore(value, qualityCore(value), "companion disposition content-quality control");
    return value;
}
function validateSafety(value, quality, qualitySha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-capture-safety-review-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.automaticArchiveRows !== 0
        || value.authorizesSoftArchive !== false
        || value.authorizesLifecycleMutation !== false
        || value.contentQualityPlanDigest !== quality.planDigest
        || value.contentQualityPreviewSha256 !== qualitySha256
        || !Array.isArray(value.rows))
        throw new Error("companion disposition capture-safety control is invalid or unbound");
    validateDigestCore(value, safetyCore(value), "companion disposition capture-safety control");
    return value;
}
function classification(metadata, evidence) {
    const explicit = String(evidence.classification ?? "").trim();
    if (explicit)
        return explicit;
    const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
    if (source.includes("reflection") || source.includes("summary") || source.includes("digest"))
        return "reflection_summary";
    return "unknown_legacy";
}
function candidateRows(db) {
    return db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,i.lifecycle,i.verification,
    l.metadata,COALESCE((SELECT s.evidence_json FROM memory_sources s WHERE s.revision_id=i.current_revision_id
      ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
    FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
    WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all();
}
function validateLineage(row, expectedDigest) {
    const metadata = parseRecord(row.metadata);
    const evidence = parseRecord(row.evidence_json);
    const lineage = evidence.sourceLineageReceiptV1;
    if (!validateSourceLineageReceiptV1(lineage, classification(metadata, evidence))
        || hash(JSON.stringify(lineage)) !== expectedDigest)
        throw new Error("companion disposition source-lineage evidence no longer matches");
    return evidence;
}
function assertCurrentRow(row, expected) {
    if (row.lifecycle !== "candidate"
        || row.verification !== "unverified"
        || hash(row.item_id) !== expected.itemIdSha256
        || hash(row.current_revision_id) !== expected.currentRevisionIdSha256
        || hash(row.content) !== expected.contentDigest
        || hash(normalizeCandidateContentV1(row.content)) !== expected.normalizedContentDigest
        || row.category !== expected.category)
        throw new Error("companion disposition live candidate no longer matches the accepted controls");
}
export function validateLiveCandidateCompanionDispositionPlanV1(value, expectedDigest) {
    const plan = value;
    if (plan?.schemaVersion !== 1
        || plan.phase !== "clawlore-candidate-companion-disposition-plan"
        || plan.readOnly !== true
        || plan.queryOnly !== true
        || plan.emitsMemoryContent !== false
        || plan.emitsTranscriptContent !== false
        || plan.emitsRawIdentifiers !== false
        || plan.softArchiveProposalRows !== 3
        || plan.mutationReadyRows !== 0
        || plan.authorizesContentRewrite !== false
        || plan.authorizesSoftArchive !== false
        || plan.authorizesHardDelete !== false
        || plan.authorizesLifecycleMutation !== false
        || plan.authorizesVerificationMutation !== false
        || plan.authorizesContextEngine !== false
        || plan.authorizesPromptMutation !== false
        || plan.authorizesFinalRecall !== false
        || plan.requiresFreshEncryptedSnapshot !== true
        || plan.requiresSeparateExactApply !== true
        || plan.summary.targetGroups !== 3
        || plan.summary.targetRows !== 3
        || plan.summary.softArchiveProposalRows !== 3
        || plan.summary.mutationReadyRows !== 0
        || plan.rows.length !== 3
        || (expectedDigest !== undefined && plan.planDigest !== expectedDigest))
        throw new Error("companion disposition plan is invalid or outside the exact three-row lane");
    const core = {
        proposedDispositionId: plan.proposedDispositionId,
        rewritePlanDigest: plan.rewritePlanDigest,
        rewritePlanSha256: plan.rewritePlanSha256,
        rewriteApplyReceiptSha256: plan.rewriteApplyReceiptSha256,
        rewritePostcheckSha256: plan.rewritePostcheckSha256,
        contentQualityPlanDigest: plan.contentQualityPlanDigest,
        contentQualityPreviewSha256: plan.contentQualityPreviewSha256,
        captureSafetyPlanDigest: plan.captureSafetyPlanDigest,
        captureSafetyPreviewSha256: plan.captureSafetyPreviewSha256,
        source: plan.source,
        summary: plan.summary,
        rows: plan.rows,
    };
    validateDigestCore(plan, core, "companion disposition plan");
    planCandidateCompanionDispositionV1(plan.rows.map((row) => ({
        factKey: row.factKey,
        knowledgeCoverage: row.knowledgeCoverage,
        knowledgeEvidenceDigest: row.knowledgeEvidenceDigest,
        representativeItemIdSha256: row.representativeItemIdSha256,
        representativeCurrentRevisionIdSha256: row.representativeCurrentRevisionIdSha256,
        representativeContentDigest: row.representativeContentDigest,
        representativeNormalizedContentDigest: row.representativeNormalizedContentDigest,
        representativeSourceLineageReceiptDigest: row.representativeSourceLineageReceiptDigest,
        representativeRewriteReceiptDigest: row.representativeRewriteReceiptDigest,
        companionItemIdSha256: row.companionItemIdSha256,
        companionCurrentRevisionIdSha256: row.companionCurrentRevisionIdSha256,
        companionContentDigest: row.companionContentDigest,
        companionNormalizedContentDigest: row.companionNormalizedContentDigest,
        companionSourceLineageReceiptDigest: row.companionSourceLineageReceiptDigest,
        category: row.category,
        captureSafetyReason: row.captureSafetyReason,
        captureSafetyPattern: row.captureSafetyPattern,
        captureSafetyLane: row.captureSafetyLane,
    })));
    return plan;
}
function assertPlanRowsAgainstLive(plan, rows) {
    const byHash = new Map(rows.map((row) => [hash(row.item_id), row]));
    for (const planned of plan.rows) {
        const representative = byHash.get(planned.representativeItemIdSha256);
        const companion = byHash.get(planned.companionItemIdSha256);
        if (!representative || !companion)
            throw new Error("companion disposition live target mapping is incomplete");
        assertCurrentRow(representative, {
            itemIdSha256: planned.representativeItemIdSha256,
            currentRevisionIdSha256: planned.representativeCurrentRevisionIdSha256,
            contentDigest: planned.representativeContentDigest,
            normalizedContentDigest: planned.representativeNormalizedContentDigest,
            category: planned.category,
        });
        const representativeEvidence = validateLineage(representative, planned.representativeSourceLineageReceiptDigest);
        if (hash(JSON.stringify(representativeEvidence.durableRewriteReceiptV1)) !== planned.representativeRewriteReceiptDigest) {
            throw new Error("companion disposition representative rewrite receipt no longer matches");
        }
        assertCurrentRow(companion, {
            itemIdSha256: planned.companionItemIdSha256,
            currentRevisionIdSha256: planned.companionCurrentRevisionIdSha256,
            contentDigest: planned.companionContentDigest,
            normalizedContentDigest: planned.companionNormalizedContentDigest,
            category: planned.category,
        });
        validateLineage(companion, planned.companionSourceLineageReceiptDigest);
    }
}
export function createLiveCandidateCompanionDispositionPlanV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedDispositionId)) {
        throw new Error("proposed companion disposition id is invalid");
    }
    const rewriteLoaded = privateJson(input.rewritePlanPath);
    const rewrite = validateRewritePlan(rewriteLoaded.value);
    const applyLoaded = privateJson(input.rewriteApplyReceiptPath);
    const apply = applyLoaded.value;
    if (apply?.schemaVersion !== 1
        || apply.phase !== "clawlore-candidate-durable-rewrite-live-apply"
        || apply.status !== "applied"
        || apply.planDigest !== rewrite.planDigest
        || apply.planSha256 !== rewriteLoaded.sha256
        || apply.rewrite.representativeRows !== 3
        || apply.rewrite.companionRowsPreserved !== 3
        || apply.rewrite.currentLifecycleRowsChanged !== 0
        || apply.rewrite.currentVerificationRowsChanged !== 0
        || apply.rewrite.companionRowsChanged !== 0
        || apply.rewrite.nonTargetRowsChanged !== 0
        || apply.projections.compatibilityRowsChanged !== 0
        || apply.projections.vectorRowsChanged !== 0
        || apply.projections.relationProjectionRowsChanged !== 0
        || apply.projections.pendingOutboxRowsChanged !== 0
        || apply.database.integrity !== "ok"
        || apply.database.foreignKeyViolations !== 0)
        throw new Error("companion disposition rewrite apply receipt is invalid or unbound");
    const postcheckLoaded = privateJson(input.rewritePostcheckPath);
    const postcheck = postcheckLoaded.value;
    if (postcheck?.schemaVersion !== 1
        || postcheck.phase !== "clawlore-candidate-durable-rewrite-postcheck"
        || postcheck.status !== "pass"
        || postcheck.rolloutId !== apply.rolloutId
        || postcheck.planDigest !== rewrite.planDigest
        || postcheck.applyReceiptSha256 !== applyLoaded.sha256
        || postcheck.targetBinding.representativeRows !== 3
        || postcheck.targetBinding.companionRows !== 3
        || postcheck.targetBinding.validRewriteReceiptRows !== 3
        || postcheck.targetBinding.mismatches !== 0
        || postcheck.preserved.companionRowsChanged !== 0
        || postcheck.preserved.nonTargetRowsChanged !== 0
        || postcheck.live.integrity !== "ok"
        || postcheck.live.foreignKeyViolations !== 0)
        throw new Error("companion disposition rewrite postcheck is invalid or unbound");
    const qualityLoaded = privateJson(input.contentQualityPath);
    const quality = validateQuality(qualityLoaded.value);
    const safetyLoaded = privateJson(input.captureSafetyPath);
    const safety = validateSafety(safetyLoaded.value, quality, qualityLoaded.sha256);
    if (!sameCompanionDispositionSourceV1(apply.source, postcheckSource(postcheck.live))
        || !sameCompanionDispositionSourceV1(apply.source, quality.source)
        || !sameCompanionDispositionSourceV1(apply.source, safety.source))
        throw new Error("companion disposition controls do not share one live source state");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const before = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(before, apply.source)) {
            throw new Error("live source no longer matches the post-rewrite controls");
        }
        const candidates = candidateRows(db);
        if (candidates.length !== before.candidateRows)
            throw new Error("companion disposition candidate mapping is incomplete");
        const byHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
        const qualityByHash = new Map(quality.rows.map((row) => [row.itemIdSha256, row]));
        const safetyByHash = new Map(safety.rows.map((row) => [row.itemIdSha256, row]));
        const rewriteRowsByHash = new Map(rewrite.rows.map((row) => [row.itemIdSha256, row]));
        const dispositionInputs = [];
        for (const group of rewrite.groups) {
            const representativeControl = rewriteRowsByHash.get(group.representativeItemIdSha256);
            const companionControl = rewriteRowsByHash.get(group.companionItemIdSha256);
            const representative = byHash.get(group.representativeItemIdSha256);
            const companion = byHash.get(group.companionItemIdSha256);
            const representativeQuality = qualityByHash.get(group.representativeItemIdSha256);
            const companionQuality = qualityByHash.get(group.companionItemIdSha256);
            const companionSafety = safetyByHash.get(group.companionItemIdSha256);
            if (!representativeControl || representativeControl.role !== "rewrite_representative"
                || !companionControl || companionControl.role !== "post_rewrite_dedupe_hold"
                || !representative || !companion || !representativeQuality || !companionQuality || !companionSafety) {
                throw new Error("companion disposition group binding is incomplete");
            }
            assertCurrentRow(representative, {
                itemIdSha256: group.representativeItemIdSha256,
                currentRevisionIdSha256: representativeQuality.currentRevisionIdSha256,
                contentDigest: group.proposedContentDigest,
                normalizedContentDigest: group.proposedNormalizedContentDigest,
                category: group.category,
            });
            const representativeEvidence = validateLineage(representative, representativeQuality.sourceLineageReceiptDigest);
            const rewriteReceipt = representativeEvidence.durableRewriteReceiptV1;
            if (rewriteReceipt?.schemaVersion !== 1
                || rewriteReceipt.rolloutId !== apply.rolloutId
                || rewriteReceipt.planDigest !== rewrite.planDigest
                || rewriteReceipt.factKey !== group.factKey
                || rewriteReceipt.previousContentDigest !== representativeControl.contentDigest
                || rewriteReceipt.rewrittenContentDigest !== group.proposedContentDigest
                || rewriteReceipt.sourceLineageReceiptDigest !== representativeQuality.sourceLineageReceiptDigest
                || rewriteReceipt.preservesCurrentLifecycle !== true
                || rewriteReceipt.preservesVerification !== true
                || rewriteReceipt.preservesAddress !== true)
                throw new Error("companion disposition representative rewrite evidence is invalid");
            assertCurrentRow(companion, {
                itemIdSha256: group.companionItemIdSha256,
                currentRevisionIdSha256: companionControl.currentRevisionIdSha256,
                contentDigest: companionControl.contentDigest,
                normalizedContentDigest: companionControl.normalizedContentDigest,
                category: group.category,
            });
            validateLineage(companion, companionControl.sourceLineageReceiptDigest);
            if (companionQuality.currentRevisionIdSha256 !== companionControl.currentRevisionIdSha256
                || companionQuality.contentDigest !== companionControl.contentDigest
                || companionQuality.normalizedContentDigest !== companionControl.normalizedContentDigest
                || companionQuality.sourceLineageReceiptDigest !== companionControl.sourceLineageReceiptDigest
                || companionQuality.captureSafety.allowed !== false
                || companionQuality.captureSafety.reason !== "operational-trace"
                || companionQuality.lane !== "capture_safety_reject_review"
                || companionSafety.currentRevisionIdSha256 !== companionControl.currentRevisionIdSha256
                || companionSafety.contentDigest !== companionControl.contentDigest
                || companionSafety.normalizedContentDigest !== companionControl.normalizedContentDigest
                || companionSafety.sourceLineageReceiptDigest !== companionControl.sourceLineageReceiptDigest
                || companionSafety.captureSafetyReason !== "operational-trace"
                || !["command_trace_rejection_review", "tool_payload_rejection_review"].includes(companionSafety.lane)
                || companionSafety.proposedLifecycle !== "candidate"
                || companionSafety.proposedVerification !== "unverified")
                throw new Error("companion disposition unsafe trace evidence is invalid or drifted");
            dispositionInputs.push({
                factKey: group.factKey,
                knowledgeCoverage: group.knowledgeCoverage,
                knowledgeEvidenceDigest: group.knowledgeEvidenceDigest,
                representativeItemIdSha256: group.representativeItemIdSha256,
                representativeCurrentRevisionIdSha256: representativeQuality.currentRevisionIdSha256,
                representativeContentDigest: group.proposedContentDigest,
                representativeNormalizedContentDigest: group.proposedNormalizedContentDigest,
                representativeSourceLineageReceiptDigest: representativeQuality.sourceLineageReceiptDigest,
                representativeRewriteReceiptDigest: hash(JSON.stringify(rewriteReceipt)),
                companionItemIdSha256: group.companionItemIdSha256,
                companionCurrentRevisionIdSha256: companionControl.currentRevisionIdSha256,
                companionContentDigest: companionControl.contentDigest,
                companionNormalizedContentDigest: companionControl.normalizedContentDigest,
                companionSourceLineageReceiptDigest: companionControl.sourceLineageReceiptDigest,
                category: group.category,
                captureSafetyReason: "operational-trace",
                captureSafetyPattern: companionSafety.captureSafetyPattern,
                captureSafetyLane: companionSafety.lane,
            });
        }
        const disposition = planCandidateCompanionDispositionV1(dispositionInputs);
        const after = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(before, after))
            throw new Error("live source changed during companion disposition planning");
        const core = {
            proposedDispositionId: input.proposedDispositionId,
            rewritePlanDigest: rewrite.planDigest,
            rewritePlanSha256: rewriteLoaded.sha256,
            rewriteApplyReceiptSha256: applyLoaded.sha256,
            rewritePostcheckSha256: postcheckLoaded.sha256,
            contentQualityPlanDigest: quality.planDigest,
            contentQualityPreviewSha256: qualityLoaded.sha256,
            captureSafetyPlanDigest: safety.planDigest,
            captureSafetyPreviewSha256: safetyLoaded.sha256,
            source: before,
            summary: disposition.summary,
            rows: disposition.rows,
        };
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-companion-disposition-plan",
            createdAt: (input.now ?? (() => new Date()))().toISOString(),
            readOnly: true,
            queryOnly: true,
            emitsMemoryContent: false,
            emitsTranscriptContent: false,
            emitsRawIdentifiers: false,
            softArchiveProposalRows: 3,
            mutationReadyRows: 0,
            authorizesContentRewrite: false,
            authorizesSoftArchive: false,
            authorizesHardDelete: false,
            authorizesLifecycleMutation: false,
            authorizesVerificationMutation: false,
            authorizesContextEngine: false,
            authorizesPromptMutation: false,
            authorizesFinalRecall: false,
            requiresFreshEncryptedSnapshot: true,
            requiresSeparateExactApply: true,
            ...core,
            planDigest: hash(JSON.stringify(core)),
        };
    }
    finally {
        db.close();
    }
}
export function acceptLiveCandidateCompanionDispositionPlanV1(input) {
    const loaded = privateJson(input.planPath);
    const plan = validateLiveCandidateCompanionDispositionPlanV1(loaded.value, input.planDigest);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const before = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(before, plan.source)) {
            throw new Error("live source no longer matches the companion disposition plan");
        }
        const candidates = candidateRows(db);
        if (candidates.length !== before.candidateRows)
            throw new Error("companion disposition acceptance candidate mapping is incomplete");
        assertPlanRowsAgainstLive(plan, candidates);
        const after = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(before, after))
            throw new Error("live source changed during companion disposition acceptance");
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-companion-disposition-acceptance",
            acceptedAt: (input.now ?? (() => new Date()))().toISOString(),
            status: "pass",
            planDigest: plan.planDigest,
            planSha256: loaded.sha256,
            summary: plan.summary,
            live: before,
            liveBindingMismatches: 0,
            decisionEvidenceMismatches: 0,
            rawTraceOrIdentifierLeak: false,
            authorizesSoftArchive: false,
            authorizesLifecycleMutation: false,
            requiresFreshEncryptedSnapshot: true,
            requiresSeparateExactApply: true,
        };
    }
    finally {
        db.close();
    }
}
export function digestLiveCandidateCompanionDispositionPlanCoreV1(plan) {
    return digestCandidateCompanionDispositionV1({
        proposedDispositionId: plan.proposedDispositionId,
        rewritePlanDigest: plan.rewritePlanDigest,
        rewritePlanSha256: plan.rewritePlanSha256,
        rewriteApplyReceiptSha256: plan.rewriteApplyReceiptSha256,
        rewritePostcheckSha256: plan.rewritePostcheckSha256,
        contentQualityPlanDigest: plan.contentQualityPlanDigest,
        contentQualityPreviewSha256: plan.contentQualityPreviewSha256,
        captureSafetyPlanDigest: plan.captureSafetyPlanDigest,
        captureSafetyPreviewSha256: plan.captureSafetyPreviewSha256,
        source: plan.source,
        summary: plan.summary,
        rows: plan.rows,
    });
}
