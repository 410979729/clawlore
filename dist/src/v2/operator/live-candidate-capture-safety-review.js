import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { normalizeCandidateContentV1, validateSourceLineageReceiptV1, } from "../application/candidate-content-quality-review.js";
import { planCandidateCaptureSafetyReviewV1, } from "../application/candidate-capture-safety-review.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
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
function privateJson(path) {
    if (process.platform === "win32")
        preparePrivateFileForRead(path);
    const info = statSync(path);
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
        throw new Error("capture-safety review input must be a non-empty owner-only JSON file");
    }
    const bytes = readFileSync(path);
    return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
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
function sourceMatches(left, right) {
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
function classification(metadata, evidence) {
    const explicit = String(evidence.classification ?? "").trim();
    if (explicit)
        return explicit;
    const source = String(metadata.source ?? metadata.source_type ?? "").toLowerCase();
    if (source.includes("manual") || source.includes("user"))
        return "explicit_manual";
    if (source.includes("reflection") || source.includes("summary") || source.includes("digest")) {
        return "reflection_summary";
    }
    if (source.includes("task") && source.includes("experience"))
        return "task_experience";
    if (source.includes("checkpoint") || source.includes("pressure"))
        return "operational_checkpoint";
    if (source.includes("capture"))
        return "auto_capture";
    return "unknown_legacy";
}
function validateContentQualityControl(value) {
    const plan = value;
    if (plan?.schemaVersion !== 1
        || plan.phase !== "clawlore-candidate-content-quality-review-plan"
        || plan.readOnly !== true
        || plan.queryOnly !== true
        || plan.emitsMemoryContent !== false
        || plan.emitsTranscriptContent !== false
        || plan.emitsRawIdentifiers !== false
        || plan.emitsContentDigests !== true
        || plan.automaticReviewRows !== 0
        || plan.authorizesContentRewrite !== false
        || plan.authorizesSoftArchive !== false
        || plan.authorizesHardDelete !== false
        || plan.authorizesLifecycleMutation !== false
        || plan.authorizesVerificationMutation !== false
        || plan.authorizesContextEngine !== false
        || plan.authorizesPromptMutation !== false
        || plan.authorizesFinalRecall !== false
        || plan.requiresOperatorSemanticReview !== true
        || !Array.isArray(plan.rows)
        || !isDigest(plan.planDigest))
        throw new Error("capture-safety review content-quality control is invalid");
    const core = {
        proposedReviewId: plan.proposedReviewId,
        remediationPlanDigest: plan.remediationPlanDigest,
        remediationPreviewSha256: plan.remediationPreviewSha256,
        source: plan.source,
        counts: plan.counts,
        summary: plan.summary,
        rows: plan.rows,
    };
    if (hash(JSON.stringify(core)) !== plan.planDigest) {
        throw new Error("capture-safety review content-quality digest is invalid");
    }
    const unsafe = plan.rows.filter((row) => row.lane === "capture_safety_reject_review");
    if (unsafe.length === 0 || unsafe.length !== plan.counts.capture_safety_reject_review) {
        throw new Error("capture-safety review target count is invalid");
    }
    return plan;
}
function assertLiveRowMatchesPlan(row, planned) {
    if (row.lifecycle !== "candidate"
        || row.verification !== "unverified"
        || hash(row.item_id) !== planned.itemIdSha256
        || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
        || hash(row.content) !== planned.contentDigest
        || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
        || row.category !== planned.category)
        throw new Error("capture-safety review live candidate no longer matches the content-quality control");
    const metadata = parseRecord(row.metadata);
    const evidence = parseRecord(row.evidence_json);
    const receipt = evidence.sourceLineageReceiptV1;
    if (!validateSourceLineageReceiptV1(receipt, classification(metadata, evidence))
        || hash(JSON.stringify(receipt)) !== planned.sourceLineageReceiptDigest)
        throw new Error("capture-safety review source-lineage receipt no longer matches the content-quality control");
}
export function createLiveCandidateCaptureSafetyReviewPlanV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedReviewId)) {
        throw new Error("proposed capture-safety review id is invalid");
    }
    const loaded = privateJson(input.contentQualityPreviewPath);
    const contentPlan = validateContentQualityControl(loaded.value);
    const plannedByItemHash = new Map(contentPlan.rows.map((row) => [row.itemIdSha256, row]));
    if (plannedByItemHash.size !== contentPlan.rows.length) {
        throw new Error("capture-safety review content-quality rows must be unique");
    }
    const unsafeRows = contentPlan.rows.filter((row) => row.lane === "capture_safety_reject_review");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const before = sourceState(db);
        if (!sourceMatches(before, contentPlan.source)) {
            throw new Error("live source no longer matches the capture-safety content-quality control");
        }
        const candidates = db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,
      i.lifecycle,i.verification,l.metadata,
      COALESCE((SELECT s.evidence_json FROM memory_sources s
        WHERE s.revision_id=i.current_revision_id ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
      FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
      WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all();
        if (candidates.length !== before.candidateRows)
            throw new Error("capture-safety review candidate mapping is incomplete");
        const liveByItemHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
        for (const [itemHash, planned] of plannedByItemHash) {
            const live = liveByItemHash.get(itemHash);
            if (!live)
                throw new Error("capture-safety review content-quality target mapping is incomplete");
            assertLiveRowMatchesPlan(live, planned);
        }
        const assessment = planCandidateCaptureSafetyReviewV1(unsafeRows);
        const after = sourceState(db);
        if (!sourceMatches(before, after))
            throw new Error("live source changed during capture-safety review planning");
        const core = {
            proposedReviewId: input.proposedReviewId,
            contentQualityPlanDigest: contentPlan.planDigest,
            contentQualityPreviewSha256: loaded.sha256,
            source: before,
            counts: assessment.counts,
            summary: assessment.summary,
            rows: assessment.rows,
        };
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-capture-safety-review-plan",
            createdAt: (input.now ?? (() => new Date()))().toISOString(),
            readOnly: true,
            queryOnly: true,
            emitsMemoryContent: false,
            emitsTranscriptContent: false,
            emitsRawIdentifiers: false,
            automaticArchiveRows: 0,
            authorizesRejectionMutation: false,
            authorizesContentRewrite: false,
            authorizesSoftArchive: false,
            authorizesHardDelete: false,
            authorizesLifecycleMutation: false,
            authorizesVerificationMutation: false,
            authorizesContextEngine: false,
            authorizesPromptMutation: false,
            authorizesFinalRecall: false,
            requiresOperatorDecision: true,
            ...core,
            planDigest: hash(JSON.stringify(core)),
        };
    }
    finally {
        db.close();
    }
}
