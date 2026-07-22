import { evaluateCaptureSafety } from "../../capture-safety.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { normalizeCandidateContentV1 } from "../application/candidate-content-quality-review.js";
import { companionDispositionSourceStateV1, sameCompanionDispositionSourceV1, } from "./live-candidate-companion-disposition.js";
import { candidateGovernanceSourceLogicalDigestV1, validateAppendedCandidateArchiveDecisionControlV1, } from "./live-candidate-governance-archive-plan.js";
const require = createRequire(import.meta.url);
const APPENDED_TARGET_ROWS = 88;
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
function candidates(db) {
    return db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,s.evidence_json
    FROM memory_items i JOIN memory_sources s ON s.source_id=(SELECT s2.source_id FROM memory_sources s2
      WHERE s2.revision_id=i.current_revision_id ORDER BY s2.source_id LIMIT 1)
    WHERE i.lifecycle='candidate' AND i.verification='unverified' ORDER BY i.item_id`).all();
}
function decisionCore(value) {
    return {
        decisionId: value.decisionId,
        sourceRolloutId: value.sourceRolloutId,
        source: value.source,
        sourceLogicalDigest: value.sourceLogicalDigest,
        summary: value.summary,
        rows: value.rows,
    };
}
export function createAppendedCandidateArchiveDecisionControlV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.decisionId)
        || !/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.sourceRolloutId)
        || !isDigest(input.explicitManualContentDigest)
        || !isDigest(input.unknownLegacyContentDigest)) {
        throw new Error("appended candidate decision inputs are invalid");
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const source = companionDispositionSourceStateV1(db);
        const sourceLogicalDigest = candidateGovernanceSourceLogicalDigestV1(db);
        const appended = candidates(db).filter((row) => {
            const evidence = parseRecord(row.evidence_json);
            return evidence.appendOnlyV1Delta === true && evidence.rolloutId === input.sourceRolloutId;
        });
        if (appended.length !== APPENDED_TARGET_ROWS)
            throw new Error("appended candidate decision target set is not exactly 88 rows");
        const rows = appended.map((row) => {
            const evidence = parseRecord(row.evidence_json);
            const classification = String(evidence.classification);
            if (!["reflection_summary", "operational_checkpoint", "explicit_manual", "unknown_legacy"].includes(classification)) {
                throw new Error("appended candidate classification is outside the reviewed lane");
            }
            const contentDigest = hash(row.content);
            const safety = evaluateCaptureSafety(row.content);
            let reason;
            if (classification === "reflection_summary") {
                reason = safety.allowed ? "transient_reflection_summary" : "capture_unsafe_automatic_trace";
            }
            else if (classification === "operational_checkpoint") {
                reason = "operational_checkpoint_noise";
            }
            else if (classification === "explicit_manual") {
                if (contentDigest !== input.explicitManualContentDigest)
                    throw new Error("explicit manual review digest no longer matches");
                reason = "obsolete_cross_instance_policy";
            }
            else {
                if (contentDigest !== input.unknownLegacyContentDigest)
                    throw new Error("unknown legacy review digest no longer matches");
                reason = "reflection_event_trace";
            }
            const reviewEvidenceDigest = hash(JSON.stringify({
                decisionId: input.decisionId,
                sourceRolloutId: input.sourceRolloutId,
                classification,
                contentDigest,
                reason,
                captureSafetyAllowed: safety.allowed,
                captureSafetyReason: safety.reason ?? null,
            }));
            return {
                itemIdSha256: hash(row.item_id),
                currentRevisionIdSha256: hash(row.current_revision_id),
                contentDigest,
                normalizedContentDigest: hash(normalizeCandidateContentV1(row.content)),
                category: row.category,
                classification,
                sourceEvidenceDigest: hash(row.evidence_json),
                captureSafetyAllowed: safety.allowed,
                ...(safety.reason ? { captureSafetyReason: safety.reason } : {}),
                reason,
                disposition: "propose_soft_archive",
                proposedNextAction: "soft_archive_under_separate_exact_apply",
                mutationReady: false,
                proposedLifecycle: "candidate",
                proposedVerification: "unverified",
                reviewEvidenceDigest,
            };
        }).sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256));
        const count = (classification) => rows.filter((row) => row.classification === classification).length;
        const summary = {
            reviewedRows: 88,
            proposedSoftArchiveRows: 88,
            reflectionSummaryRows: count("reflection_summary"),
            operationalCheckpointRows: count("operational_checkpoint"),
            explicitManualRows: count("explicit_manual"),
            unknownLegacyRows: count("unknown_legacy"),
            captureSafetyRejectedRows: rows.filter((row) => !row.captureSafetyAllowed).length,
            captureSafetyAllowedRows: rows.filter((row) => row.captureSafetyAllowed).length,
            mutationReadyRows: 0,
        };
        if (summary.reflectionSummaryRows !== 66 || summary.operationalCheckpointRows !== 20
            || summary.explicitManualRows !== 1 || summary.unknownLegacyRows !== 1) {
            throw new Error("appended candidate classification counts no longer match the reviewed 66/20/1/1 lane");
        }
        if (!sameCompanionDispositionSourceV1(source, companionDispositionSourceStateV1(db))
            || sourceLogicalDigest !== candidateGovernanceSourceLogicalDigestV1(db)) {
            throw new Error("source changed during appended candidate decision planning");
        }
        const partial = {
            schemaVersion: 1,
            phase: "clawlore-appended-candidate-archive-operator-decisions",
            createdAt: (input.now ?? (() => new Date()))().toISOString(),
            decisionId: input.decisionId,
            sourceRolloutId: input.sourceRolloutId,
            readOnly: true,
            queryOnly: true,
            emitsMemoryContent: false,
            emitsTranscriptContent: false,
            emitsRawIdentifiers: false,
            emitsContentDigests: true,
            authorizesSoftArchive: false,
            authorizesLifecycleMutation: false,
            requiresSeparateExactApply: true,
            source,
            sourceLogicalDigest,
            summary,
            rows,
        };
        return validateAppendedCandidateArchiveDecisionControlV1({
            ...partial,
            decisionDigest: hash(JSON.stringify(decisionCore(partial))),
        });
    }
    finally {
        db.close();
    }
}
