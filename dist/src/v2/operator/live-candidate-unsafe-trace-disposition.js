import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { evaluateCaptureSafety } from "../../capture-safety.js";
import { normalizeCandidateContentV1, validateSourceLineageReceiptV1, } from "../application/candidate-content-quality-review.js";
import { planCandidateUnsafeTraceDispositionV1, } from "../application/candidate-unsafe-trace-disposition.js";
import { companionDispositionSourceStateV1, sameCompanionDispositionSourceV1, } from "./live-candidate-companion-disposition.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const EXPECTED_TARGET_ROWS = 131;
const EXPECTED_ARCHIVE_ROWS = 99;
const EXPECTED_REWRITE_ROWS = 32;
const EXPECTED_OVERSIZED_ROWS = 7;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function privateJson(path) {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
        throw new Error("unsafe trace disposition input must be a non-empty owner-only file");
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
function validateAdjudication(value) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-unsafe-trace-adjudication-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.authorizesContentRewrite !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesHardDelete !== false
        || value.authorizesLifecycleMutation !== false
        || value.authorizesVerificationMutation !== false
        || value.requiresOperatorDecision !== true
        || value.summary?.targetRows !== EXPECTED_TARGET_ROWS
        || value.summary.softArchiveProposalRows !== EXPECTED_ARCHIVE_ROWS
        || value.summary.boundedRewriteHoldRows !== EXPECTED_REWRITE_ROWS
        || value.summary.oversizedHoldRows !== EXPECTED_OVERSIZED_ROWS
        || value.summary.mutationReadyRows !== 0
        || value.counts?.soft_archive_proposal !== EXPECTED_ARCHIVE_ROWS
        || value.counts.bounded_rewrite_hold !== EXPECTED_REWRITE_ROWS
        || !Array.isArray(value.rows)
        || value.rows.length !== EXPECTED_TARGET_ROWS
        || new Set(value.rows.map((row) => row.itemIdSha256)).size !== EXPECTED_TARGET_ROWS)
        throw new Error("unsafe trace disposition adjudication is invalid or outside the exact lane");
    const core = {
        proposedReviewId: value.proposedReviewId,
        captureSafetyPlanDigest: value.captureSafetyPlanDigest,
        captureSafetyPreviewSha256: value.captureSafetyPreviewSha256,
        source: value.source,
        counts: value.counts,
        reasons: value.reasons,
        summary: value.summary,
        rows: value.rows,
    };
    if (hash(JSON.stringify(core)) !== value.planDigest) {
        throw new Error("unsafe trace disposition adjudication digest is invalid");
    }
    return value;
}
function candidateRows(db) {
    return db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,
    i.lifecycle,i.verification,l.metadata,
    COALESCE((SELECT s.evidence_json FROM memory_sources s
      WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
    FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
    WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all();
}
function assertLiveMatch(row, planned) {
    const metadata = parseRecord(row.metadata);
    const evidence = parseRecord(row.evidence_json);
    const receipt = evidence.sourceLineageReceiptV1;
    const safety = evaluateCaptureSafety(row.content);
    if (row.lifecycle !== "candidate"
        || row.verification !== "unverified"
        || hash(row.item_id) !== planned.itemIdSha256
        || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
        || hash(row.content) !== planned.contentDigest
        || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
        || row.category !== planned.category
        || safety.allowed !== false
        || safety.reason !== "operational-trace"
        || safety.pattern !== planned.captureSafetyPattern
        || !validateSourceLineageReceiptV1(receipt, classification(metadata, evidence))
        || hash(JSON.stringify(receipt)) !== planned.sourceLineageReceiptDigest) {
        throw new Error("unsafe trace disposition live target no longer matches the adjudication");
    }
}
export function createLiveCandidateUnsafeTraceDispositionPlanV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedDispositionId)) {
        throw new Error("unsafe trace disposition id is invalid");
    }
    const loaded = privateJson(input.adjudicationPlanPath);
    const adjudication = validateAdjudication(loaded.value);
    const disposition = planCandidateUnsafeTraceDispositionV1(adjudication.rows);
    if (disposition.summary.softArchiveRows !== EXPECTED_ARCHIVE_ROWS
        || disposition.summary.boundedRewriteRows !== EXPECTED_REWRITE_ROWS
        || disposition.summary.oversizedSegmentationRows !== EXPECTED_OVERSIZED_ROWS
        || disposition.summary.semanticExtractionRows !== EXPECTED_REWRITE_ROWS - EXPECTED_OVERSIZED_ROWS) {
        throw new Error("unsafe trace disposition design does not cover the exact 99/32 lane");
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const source = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(source, adjudication.source)) {
            throw new Error("live source no longer matches the unsafe trace adjudication");
        }
        const candidates = candidateRows(db);
        if (candidates.length !== source.candidateRows) {
            throw new Error("unsafe trace disposition candidate mapping is incomplete");
        }
        const byHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
        for (const planned of adjudication.rows) {
            const live = byHash.get(planned.itemIdSha256);
            if (!live)
                throw new Error("unsafe trace disposition target mapping is incomplete");
            assertLiveMatch(live, planned);
        }
        if (!sameCompanionDispositionSourceV1(source, companionDispositionSourceStateV1(db))) {
            throw new Error("live source changed during unsafe trace disposition planning");
        }
        const summary = { ...disposition.summary, liveBindingMismatches: 0 };
        const core = {
            proposedDispositionId: input.proposedDispositionId,
            adjudicationPlanDigest: adjudication.planDigest,
            adjudicationPlanSha256: loaded.sha256,
            source,
            summary,
            archiveRows: disposition.archiveRows,
            rewriteDesigns: disposition.rewriteDesigns,
        };
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-unsafe-trace-disposition-plan",
            createdAt: (input.now?.() ?? new Date()).toISOString(),
            proposedDispositionId: input.proposedDispositionId,
            readOnly: true,
            queryOnly: true,
            emitsMemoryContent: false,
            emitsTranscriptContent: false,
            emitsRawIdentifiers: false,
            emitsContentDigests: true,
            softArchiveProposalRows: EXPECTED_ARCHIVE_ROWS,
            boundedRewriteDesignRows: EXPECTED_REWRITE_ROWS,
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
