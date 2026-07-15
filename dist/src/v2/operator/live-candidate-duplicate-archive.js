import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { normalizeCandidateContentV1, validateSourceLineageReceiptV1, } from "../application/candidate-content-quality-review.js";
import { companionDispositionSourceStateV1, sameCompanionDispositionSourceV1, } from "./live-candidate-companion-disposition.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const TARGET_ROWS = 14;
const TARGET_GROUPS = 5;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function privateBytes(path, maximumBytes) {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > maximumBytes) {
        throw new Error("duplicate archive control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    return { bytes, sha256: hash(bytes) };
}
function privateJson(path, maximumBytes = CONTROL_MAX_BYTES) {
    const loaded = privateBytes(path, maximumBytes);
    const value = JSON.parse(loaded.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("duplicate archive control JSON is invalid");
    }
    return { value, sha256: loaded.sha256 };
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
function scalar(db, sql, ...args) {
    return Number(Object.values(db.prepare(sql).get(...args))[0] ?? 0);
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
function candidateRows(db, lifecycle = "candidate") {
    return db.prepare(`SELECT i.item_id,i.current_revision_id,i.revision_no,i.content,i.category,
    i.address_json,i.lifecycle,i.verification,i.valid_until,l.metadata,
    s.source_id,s.source_type,s.external_id,s.observed_at,s.evidence_json
    FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
    JOIN memory_sources s ON s.source_id=(SELECT s2.source_id FROM memory_sources s2
      WHERE s2.revision_id=i.current_revision_id ORDER BY s2.source_id LIMIT 1)
    WHERE i.lifecycle=? ORDER BY i.item_id`).all(lifecycle);
}
function validateAdjudication(value) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-duplicate-trace-adjudication-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.proposesSoftArchiveRows !== TARGET_ROWS
        || value.holdsForBoundedRewriteRows !== 6
        || value.mutationReadyRows !== 0
        || value.authorizesSoftArchive !== false
        || value.authorizesLifecycleMutation !== false
        || value.requiresSeparateExactApply !== true
        || value.summary?.softArchiveGroups !== TARGET_GROUPS
        || value.summary.softArchiveRows !== TARGET_ROWS
        || !Array.isArray(value.groups)
        || !Array.isArray(value.rows)
        || value.groups.length !== value.summary.targetGroups
        || value.rows.length !== value.summary.targetRows
        || value.groups.filter((group) => group.disposition === "propose_soft_archive").length !== TARGET_GROUPS
        || value.rows.filter((row) => row.disposition === "propose_soft_archive").length !== TARGET_ROWS
        || value.groups.filter((group) => group.disposition === "hold_for_bounded_rewrite").length !== value.summary.rewriteHoldGroups
        || value.rows.filter((row) => row.disposition === "hold_for_bounded_rewrite").length !== value.summary.rewriteHoldRows
        || !isDigest(value.planDigest))
        throw new Error("duplicate archive adjudication plan is invalid");
    const core = {
        proposedAdjudicationId: value.proposedAdjudicationId,
        captureSafetyPlanDigest: value.captureSafetyPlanDigest,
        captureSafetyPreviewSha256: value.captureSafetyPreviewSha256,
        decisionControlDigest: value.decisionControlDigest,
        decisionControlSha256: value.decisionControlSha256,
        captureSafetySource: value.captureSafetySource,
        appendOnlySourceExtensionRows: value.appendOnlySourceExtensionRows,
        source: value.source,
        summary: value.summary,
        groups: value.groups,
        rows: value.rows,
    };
    if (hash(JSON.stringify(core)) !== value.planDigest) {
        throw new Error("duplicate archive adjudication digest is invalid");
    }
    return value;
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
        || value.authorizesLifecycleMutation !== false
        || value.authorizesContextEngine !== false
        || value.authorizesPromptMutation !== false
        || value.authorizesFinalRecall !== false
        || promotion?.schemaVersion !== 1
        || promotion.readOnly !== true
        || promotion.emitsItemIds !== false
        || promotion.authorizesLiveMutation !== false
        || promotion.automaticPromotionRows !== 0
        || !Array.isArray(promotion.rows)
        || hash(JSON.stringify(promotion.rows)) !== promotion.planDigest
        || promotion.rows.length !== value.source.candidateRows
        || new Set(promotion.rows.map((row) => row.itemIdSha256)).size !== promotion.rows.length
        || value.decision.eligibleRows !== 0
        || value.decision.lifecycleRolloutSelectable !== false
        || value.decision.automaticPromotionRows !== 0)
        throw new Error("duplicate archive candidate baseline is invalid or mutation-capable");
    return value;
}
function validateSafety(value) {
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
        || !Array.isArray(value.rows)
        || !isDigest(value.planDigest))
        throw new Error("duplicate archive capture-safety plan is invalid");
    const core = {
        proposedReviewId: value.proposedReviewId,
        contentQualityPlanDigest: value.contentQualityPlanDigest,
        contentQualityPreviewSha256: value.contentQualityPreviewSha256,
        source: value.source,
        counts: value.counts,
        summary: value.summary,
        rows: value.rows,
    };
    if (hash(JSON.stringify(core)) !== value.planDigest) {
        throw new Error("duplicate archive capture-safety digest is invalid");
    }
    return value;
}
function selectedTargets(adjudication) {
    const groups = adjudication.groups.filter((group) => group.disposition === "propose_soft_archive");
    const rows = adjudication.rows.filter((row) => row.disposition === "propose_soft_archive");
    if (groups.length !== TARGET_GROUPS
        || rows.length !== TARGET_ROWS
        || new Set(rows.map((row) => row.itemIdSha256)).size !== TARGET_ROWS
        || groups.some((group) => rows.filter((row) => row.normalizedContentDigest === group.normalizedContentDigest).length
            !== group.expectedGroupSize)
        || rows.some((row) => row.mutationReady !== false
            || row.proposedLifecycle !== "candidate"
            || row.proposedVerification !== "unverified"
            || row.proposedNextAction !== "soft_archive_under_separate_exact_apply"))
        throw new Error("duplicate archive target set is not the exact five-group fourteen-row lane");
    return {
        groups: [...groups].sort((left, right) => left.normalizedContentDigest.localeCompare(right.normalizedContentDigest)),
        rows: [...rows].sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256)),
    };
}
function assertLiveRowMatches(row, planned) {
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
        throw new Error("duplicate archive live target no longer matches the accepted adjudication");
}
function validateCurrentBindings(input) {
    const source = companionDispositionSourceStateV1(input.db);
    if (!sameCompanionDispositionSourceV1(source, input.plan.source)) {
        throw new Error("live source no longer matches the duplicate archive plan");
    }
    const candidates = candidateRows(input.db);
    if (candidates.length !== source.candidateRows)
        throw new Error("duplicate archive candidate mapping is incomplete");
    const byHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
    for (const planned of input.plan.rows) {
        const live = byHash.get(planned.itemIdSha256);
        if (!live)
            throw new Error("duplicate archive target mapping is incomplete");
        assertLiveRowMatches(live, planned);
    }
    return byHash;
}
function validatePlan(value, expectedDigest) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-duplicate-soft-archive-plan"
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.softArchiveProposalRows !== TARGET_ROWS
        || value.targetGroups !== TARGET_GROUPS
        || value.mutationReadyRows !== 0
        || value.authorizesContentRewrite !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesHardDelete !== false
        || value.authorizesLifecycleMutation !== false
        || value.authorizesVerificationMutation !== false
        || value.authorizesContextEngine !== false
        || value.authorizesPromptMutation !== false
        || value.authorizesFinalRecall !== false
        || value.requiresFreshEncryptedSnapshot !== true
        || value.requiresSeparateExactApply !== true
        || !isDigest(value.planDigest)
        || (expectedDigest && value.planDigest !== expectedDigest))
        throw new Error("duplicate archive plan is invalid or authorizing");
    const core = {
        proposedArchiveId: value.proposedArchiveId,
        adjudicationPlanDigest: value.adjudicationPlanDigest,
        adjudicationPlanSha256: value.adjudicationPlanSha256,
        candidateBaselinePlanDigest: value.candidateBaselinePlanDigest,
        candidateBaselineSha256: value.candidateBaselineSha256,
        captureSafetyPlanDigest: value.captureSafetyPlanDigest,
        captureSafetySha256: value.captureSafetySha256,
        source: value.source,
        summary: value.summary,
        groups: value.groups,
        rows: value.rows,
    };
    if (hash(JSON.stringify(core)) !== value.planDigest)
        throw new Error("duplicate archive plan digest is invalid");
    selectedTargets({ groups: value.groups, rows: value.rows });
    return value;
}
export function createLiveCandidateDuplicateArchivePlanV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.proposedArchiveId)) {
        throw new Error("duplicate archive id is invalid");
    }
    const loadedAdjudication = privateJson(input.adjudicationPlanPath);
    const adjudication = validateAdjudication(loadedAdjudication.value);
    const targets = selectedTargets(adjudication);
    const loadedBaseline = privateJson(input.candidateBaselinePath);
    const baseline = validateBaseline(loadedBaseline.value);
    const loadedSafety = privateJson(input.captureSafetyPath);
    const safety = validateSafety(loadedSafety.value);
    if (!sameCompanionDispositionSourceV1(baseline.source, safety.source)) {
        throw new Error("duplicate archive latest controls do not share one live source");
    }
    const baselineByHash = new Map(baseline.candidatePromotionPlan.rows.map((row) => [row.itemIdSha256, row]));
    const safetyByHash = new Map(safety.rows.map((row) => [row.itemIdSha256, row]));
    for (const planned of targets.rows) {
        if (baselineByHash.get(planned.itemIdSha256)?.disposition !== "hold_candidate") {
            throw new Error("duplicate archive target is outside the latest hold-candidate baseline");
        }
        const current = safetyByHash.get(planned.itemIdSha256);
        if (current?.lane !== "exact_duplicate_operational_trace_review"
            || current.currentRevisionIdSha256 !== planned.currentRevisionIdSha256
            || current.contentDigest !== planned.contentDigest
            || current.normalizedContentDigest !== planned.normalizedContentDigest
            || current.sourceLineageReceiptDigest !== planned.sourceLineageReceiptDigest
            || current.category !== planned.category
            || current.captureSafetyReason !== planned.captureSafetyReason
            || current.captureSafetyPattern !== planned.captureSafetyPattern)
            throw new Error("duplicate archive target is not unchanged in the latest capture-safety control");
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    let source;
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        source = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(source, baseline.source)) {
            throw new Error("live source no longer matches the latest duplicate archive controls");
        }
        const candidates = candidateRows(db);
        const byHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
        for (const planned of targets.rows) {
            const live = byHash.get(planned.itemIdSha256);
            if (!live)
                throw new Error("duplicate archive live target mapping is incomplete");
            assertLiveRowMatches(live, planned);
        }
        if (!sameCompanionDispositionSourceV1(source, companionDispositionSourceStateV1(db))) {
            throw new Error("live source changed during duplicate archive planning");
        }
    }
    finally {
        db.close();
    }
    const summary = {
        targetGroups: TARGET_GROUPS,
        targetRows: TARGET_ROWS,
        coveredByExistingTruthRows: targets.rows.filter((row) => row.basis === "covered_by_existing_truth").length,
        transientOperationalTraceRows: targets.rows.filter((row) => row.basis === "transient_operational_trace").length,
        liveBindingMismatches: 0,
    };
    const core = {
        proposedArchiveId: input.proposedArchiveId,
        adjudicationPlanDigest: adjudication.planDigest,
        adjudicationPlanSha256: loadedAdjudication.sha256,
        candidateBaselinePlanDigest: baseline.candidatePromotionPlan.planDigest,
        candidateBaselineSha256: loadedBaseline.sha256,
        captureSafetyPlanDigest: safety.planDigest,
        captureSafetySha256: loadedSafety.sha256,
        source,
        summary,
        groups: targets.groups,
        rows: targets.rows,
    };
    return {
        schemaVersion: 1,
        phase: "clawlore-candidate-duplicate-soft-archive-plan",
        createdAt: (input.now ?? (() => new Date()))().toISOString(),
        readOnly: true,
        queryOnly: true,
        emitsMemoryContent: false,
        emitsTranscriptContent: false,
        emitsRawIdentifiers: false,
        softArchiveProposalRows: TARGET_ROWS,
        targetGroups: TARGET_GROUPS,
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
export function acceptLiveCandidateDuplicateArchivePlanV1(input) {
    const loaded = privateJson(input.planPath);
    const plan = validatePlan(loaded.value, input.planDigest);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        validateCurrentBindings({ db, plan });
        if (!sameCompanionDispositionSourceV1(plan.source, companionDispositionSourceStateV1(db))) {
            throw new Error("live source changed during duplicate archive acceptance");
        }
    }
    finally {
        db.close();
    }
    return {
        schemaVersion: 1,
        phase: "clawlore-candidate-duplicate-soft-archive-acceptance",
        acceptedAt: (input.now ?? (() => new Date()))().toISOString(),
        status: "pass",
        planDigest: plan.planDigest,
        planSha256: loaded.sha256,
        source: plan.source,
        summary: plan.summary,
        liveBindingMismatches: 0,
        decisionEvidenceMismatches: 0,
        rawTraceOrIdentifierLeak: false,
        authorizesSoftArchive: false,
        authorizesLifecycleMutation: false,
        requiresFreshEncryptedSnapshot: true,
        requiresSeparateExactApply: true,
    };
}
function validateAcceptance(value, plan, planSha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-duplicate-soft-archive-acceptance"
        || value.status !== "pass"
        || value.planDigest !== plan.planDigest
        || value.planSha256 !== planSha256
        || !sameCompanionDispositionSourceV1(value.source, plan.source)
        || JSON.stringify(value.summary) !== JSON.stringify(plan.summary)
        || value.liveBindingMismatches !== 0
        || value.decisionEvidenceMismatches !== 0
        || value.rawTraceOrIdentifierLeak !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesLifecycleMutation !== false
        || value.requiresFreshEncryptedSnapshot !== true
        || value.requiresSeparateExactApply !== true)
        throw new Error("duplicate archive acceptance is invalid or unbound");
}
function validateFreshSnapshot(input) {
    const receipt = privateJson(input.receiptPath, 128 * 1024);
    const archive = privateBytes(input.archivePath, 1024 * 1024 * 1024);
    const createdAt = Date.parse(receipt.value.createdAt);
    const ageSeconds = Number.isFinite(createdAt)
        ? Math.max(0, Math.floor((input.now.getTime() - createdAt) / 1000))
        : Number.POSITIVE_INFINITY;
    if (receipt.value.schemaVersion !== 1
        || receipt.value.phase !== "clawlore-v2-live-encrypted-snapshot"
        || receipt.value.status !== "pass"
        || receipt.value.authorizesV2Writes !== false
        || receipt.value.sourceStableDuringBackup !== true
        || receipt.value.restoreVerified !== true
        || receipt.value.restoredPlaintextRemoved !== true
        || receipt.value.snapshot.integrity !== "ok"
        || receipt.value.snapshot.foreignKeyViolations !== 0
        || archive.sha256 !== receipt.value.archiveSha256
        || ageSeconds > input.maximumAgeSeconds)
        throw new Error("fresh encrypted snapshot is invalid, stale, or checksum-mismatched");
    return { value: receipt.value, sha256: receipt.sha256, archiveSha256: archive.sha256 };
}
function digestQuery(db, sql, args = []) {
    return hash(JSON.stringify(db.prepare(sql).all(...args)));
}
function nonTargetDigest(db, targetItemIds) {
    const placeholders = targetItemIds.map(() => "?").join(",");
    return hash(JSON.stringify([
        digestQuery(db, `SELECT * FROM memory_items WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_revisions WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,revision_no`, targetItemIds),
        digestQuery(db, `SELECT s.* FROM memory_sources s JOIN memory_revisions r ON r.revision_id=s.revision_id
      WHERE r.item_id NOT IN (${placeholders}) ORDER BY r.item_id,s.source_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_acl WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,acl_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_events WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,event_id`, targetItemIds),
        digestQuery(db, `SELECT rel.* FROM memory_relations rel
      JOIN memory_revisions fr ON fr.revision_id=rel.from_revision_id
      JOIN memory_revisions tr ON tr.revision_id=rel.to_revision_id
      WHERE fr.item_id NOT IN (${placeholders}) AND tr.item_id NOT IN (${placeholders})
      ORDER BY rel.relation_id`, [...targetItemIds, ...targetItemIds]),
        digestQuery(db, `SELECT * FROM memory_fts_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_fts_compat_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_vector_projection_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_relation_projection_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, "SELECT * FROM projection_outbox ORDER BY outbox_id"),
    ]));
}
function targetProtectedDigest(db, targetItemIds) {
    const placeholders = targetItemIds.map(() => "?").join(",");
    return hash(JSON.stringify([
        db.prepare(`SELECT item_id,content,category,address_json,tenant_id,principal_id,agent_id,visibility,retention,
      workspace_id,project_id,conversation_id,thread_id,customer_id,task_id,verification,valid_until,created_at
      FROM memory_items WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
        db.prepare(`SELECT l.* FROM memory_truth l JOIN memory_items i ON i.item_id='legacy:' || l.id
      WHERE i.item_id IN (${placeholders}) ORDER BY l.id`).all(...targetItemIds),
        db.prepare(`SELECT * FROM memory_acl WHERE item_id IN (${placeholders}) ORDER BY item_id,acl_id`).all(...targetItemIds),
        db.prepare(`SELECT * FROM memory_fts_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
        db.prepare(`SELECT * FROM memory_fts_compat_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
        db.prepare(`SELECT * FROM memory_vector_projection_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
        db.prepare(`SELECT * FROM memory_relation_projection_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...targetItemIds),
    ]));
}
function expectedAfter(before) {
    return { ...before, candidateRows: before.candidateRows - TARGET_ROWS, archivedRows: before.archivedRows + TARGET_ROWS };
}
export async function executeLiveCandidateDuplicateArchiveV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.rolloutId))
        throw new Error("duplicate archive rollout id is invalid");
    const appliedAtDate = input.now?.() ?? new Date();
    const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
    if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
        throw new Error("maximum snapshot age must be a positive integer");
    }
    const loadedPlan = privateJson(input.planPath);
    const plan = validatePlan(loadedPlan.value, input.planDigest);
    const loadedAcceptance = privateJson(input.acceptancePath);
    validateAcceptance(loadedAcceptance.value, plan, loadedPlan.sha256);
    const snapshot = validateFreshSnapshot({
        receiptPath: input.snapshotReceiptPath,
        archivePath: input.snapshotArchivePath,
        now: appliedAtDate,
        maximumAgeSeconds,
    });
    const legacyBefore = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (legacyBefore.schemaDigest !== snapshot.value.snapshot.schemaDigest
        || legacyBefore.memoryTruth.rowCount !== snapshot.value.snapshot.memoryTruthRows
        || legacyBefore.memoryTruth.logicalDigest !== snapshot.value.snapshot.memoryTruthLogicalDigest)
        throw new Error("live V1 truth no longer matches the fresh encrypted snapshot");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
    const beforeSource = companionDispositionSourceStateV1(db);
    if (!sameCompanionDispositionSourceV1(beforeSource, plan.source)) {
        db.close();
        throw new Error("live source no longer matches the duplicate archive plan");
    }
    const byHash = validateCurrentBindings({ db, plan });
    const targetItemIds = plan.rows.map((planned) => byHash.get(planned.itemIdSha256).item_id).sort();
    const beforeNonTargetDigest = nonTargetDigest(db, targetItemIds);
    const beforeProtectedDigest = targetProtectedDigest(db, targetItemIds);
    const beforeCounts = {
        revisions: scalar(db, "SELECT COUNT(*) FROM memory_revisions"),
        sources: scalar(db, "SELECT COUNT(*) FROM memory_sources"),
        relations: scalar(db, "SELECT COUNT(*) FROM memory_relations"),
        events: scalar(db, "SELECT COUNT(*) FROM memory_events"),
        outbox: scalar(db, "SELECT COUNT(*) FROM projection_outbox"),
        rollouts: scalar(db, "SELECT COUNT(*) FROM clawlore_rollouts_v2"),
    };
    const appliedAt = appliedAtDate.toISOString();
    try {
        db.exec("BEGIN IMMEDIATE");
        if (!sameCompanionDispositionSourceV1(companionDispositionSourceStateV1(db), beforeSource)) {
            throw new Error("live source drifted before duplicate archive transaction");
        }
        const transactionCandidates = new Map(candidateRows(db).map((row) => [hash(row.item_id), row]));
        for (const planned of plan.rows) {
            const live = transactionCandidates.get(planned.itemIdSha256);
            if (!live)
                throw new Error("duplicate archive target disappeared before transaction");
            assertLiveRowMatches(live, planned);
            const revisionId = randomUUID();
            const oldEvidence = parseRecord(live.evidence_json);
            const evidence = {
                ...oldEvidence,
                duplicateTraceDispositionReceiptV1: {
                    schemaVersion: 1,
                    rolloutId: input.rolloutId,
                    planDigest: plan.planDigest,
                    normalizedContentDigest: planned.normalizedContentDigest,
                    archivedContentDigest: planned.contentDigest,
                    sourceLineageReceiptDigest: planned.sourceLineageReceiptDigest,
                    basis: planned.basis,
                    evidenceDigest: planned.evidenceDigest,
                    appliedAt,
                    preservesContent: true,
                    preservesVerification: true,
                    preservesAddress: true,
                    preservesProjections: true,
                },
            };
            const superseded = db.prepare("UPDATE memory_revisions SET lifecycle='superseded' WHERE revision_id=? AND lifecycle='candidate'")
                .run(live.current_revision_id);
            if (Number(superseded.changes) !== 1)
                throw new Error("duplicate archive current revision supersession failed closed");
            db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(revisionId, live.item_id, Number(live.revision_no) + 1, live.content, "archived", "unverified", live.valid_until, appliedAt);
            db.prepare(`INSERT INTO memory_sources
        (source_id,revision_id,source_type,external_id,observed_at,evidence_json)
        VALUES (?,?,?,?,?,?)`).run(randomUUID(), revisionId, live.source_type, live.external_id, live.observed_at, JSON.stringify(evidence));
            db.prepare(`INSERT INTO memory_relations
        (relation_id,from_revision_id,to_revision_id,relation_type,created_at)
        VALUES (?,?,?,?,?)`).run(randomUUID(), revisionId, live.current_revision_id, "supersedes", appliedAt);
            db.prepare(`INSERT INTO memory_events
        (event_id,item_id,revision_id,event_type,actor,reason,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), live.item_id, revisionId, "archived", "operator:bounded-duplicate-trace-disposition", input.rolloutId, appliedAt);
            const current = db.prepare(`UPDATE memory_items SET current_revision_id=?,revision_no=?,lifecycle='archived',updated_at=?
        WHERE item_id=? AND lifecycle='candidate' AND verification='unverified'`).run(revisionId, Number(live.revision_no) + 1, appliedAt, live.item_id);
            if (Number(current.changes) !== 1)
                throw new Error("duplicate archive current item update failed closed");
        }
        db.prepare(`INSERT INTO clawlore_rollouts_v2
      (rollout_id,plan_digest,control_sha256,readiness_sha256,legacy_logical_digest,rows_applied,
       applied_at,v1_fallback_reads,context_engine_enabled,final_recall_cutover_enabled)
      VALUES (?,?,?,?,?,?,?,1,0,0)`).run(input.rolloutId, plan.planDigest, loadedPlan.sha256, snapshot.sha256, legacyBefore.memoryTruth.logicalDigest, TARGET_ROWS, appliedAt);
        const after = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(after, expectedAfter(beforeSource))
            || nonTargetDigest(db, targetItemIds) !== beforeNonTargetDigest
            || targetProtectedDigest(db, targetItemIds) !== beforeProtectedDigest
            || scalar(db, "SELECT COUNT(*) FROM memory_revisions") !== beforeCounts.revisions + TARGET_ROWS
            || scalar(db, "SELECT COUNT(*) FROM memory_sources") !== beforeCounts.sources + TARGET_ROWS
            || scalar(db, "SELECT COUNT(*) FROM memory_relations") !== beforeCounts.relations + TARGET_ROWS
            || scalar(db, "SELECT COUNT(*) FROM memory_events") !== beforeCounts.events + TARGET_ROWS
            || scalar(db, "SELECT COUNT(*) FROM projection_outbox") !== beforeCounts.outbox
            || scalar(db, "SELECT COUNT(*) FROM clawlore_rollouts_v2") !== beforeCounts.rollouts + 1)
            throw new Error("duplicate archive transaction exceeded the exact fourteen-row boundary");
        const archived = targetItemIds.map((itemId) => db.prepare(`SELECT i.lifecycle,i.verification,i.content,
      r.lifecycle AS revision_lifecycle,r.verification AS revision_verification,s.evidence_json
      FROM memory_items i JOIN memory_revisions r ON r.revision_id=i.current_revision_id
      JOIN memory_sources s ON s.revision_id=i.current_revision_id WHERE i.item_id=?`).get(itemId));
        if (archived.some((row) => {
            const evidence = parseRecord(String(row.evidence_json));
            const receipt = evidence.duplicateTraceDispositionReceiptV1;
            return row.lifecycle !== "archived"
                || row.verification !== "unverified"
                || row.revision_lifecycle !== "archived"
                || row.revision_verification !== "unverified"
                || receipt?.planDigest !== plan.planDigest
                || receipt.preservesContent !== true
                || receipt.preservesProjections !== true;
        }))
            throw new Error("duplicate archive current revision acceptance failed");
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (integrity !== "ok" || foreignKeyViolations !== 0)
            throw new Error("duplicate archive database integrity failed");
        db.exec("COMMIT");
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* transaction may not be open */ }
        db.close();
        throw error;
    }
    const afterSource = companionDispositionSourceStateV1(db);
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    db.close();
    const legacyAfter = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (!sameCompanionDispositionSourceV1(afterSource, expectedAfter(beforeSource))
        || legacyAfter.memoryTruth.rowCount !== legacyBefore.memoryTruth.rowCount
        || legacyAfter.memoryTruth.logicalDigest !== legacyBefore.memoryTruth.logicalDigest
        || integrity !== "ok"
        || foreignKeyViolations !== 0)
        throw new Error("duplicate archive post-commit acceptance failed");
    return {
        schemaVersion: 1,
        phase: "clawlore-candidate-duplicate-soft-archive-live-apply",
        rolloutId: input.rolloutId,
        status: "applied",
        appliedAt,
        planDigest: plan.planDigest,
        planSha256: loadedPlan.sha256,
        acceptanceSha256: loadedAcceptance.sha256,
        snapshotReceiptSha256: snapshot.sha256,
        snapshotArchiveSha256: snapshot.archiveSha256,
        sourceBefore: beforeSource,
        sourceAfter: afterSource,
        archive: {
            targetGroups: TARGET_GROUPS,
            targetRows: TARGET_ROWS,
            candidateRowsArchived: TARGET_ROWS,
            newArchivedRevisionRows: TARGET_ROWS,
            oldRevisionRowsSuperseded: TARGET_ROWS,
            newSourceRows: TARGET_ROWS,
            newRelationRows: TARGET_ROWS,
            newEventRows: TARGET_ROWS,
            currentContentRowsChanged: 0,
            currentVerificationRowsChanged: 0,
            addressRowsChanged: 0,
            aclRowsChanged: 0,
            nonTargetRowsChanged: 0,
        },
        projections: {
            compatibilityRowsChanged: 0,
            currentFtsRowsChanged: 0,
            vectorRowsChanged: 0,
            relationProjectionRowsChanged: 0,
            pendingOutboxRowsChanged: 0,
        },
        database: { integrity: "ok", foreignKeyViolations: 0 },
        runtime: {
            v1FallbackReads: true,
            existingCandidateLifecycleMutationEnabled: false,
            contextEngineEnabled: false,
            promptMutationEnabled: false,
            finalRecallCutoverEnabled: false,
        },
    };
}
export function inspectLiveCandidateDuplicateArchiveV1(input) {
    const loadedPlan = privateJson(input.planPath);
    const plan = validatePlan(loadedPlan.value, input.planDigest);
    const loadedApply = privateJson(input.applyReceiptPath);
    const apply = loadedApply.value;
    if (apply?.schemaVersion !== 1
        || apply.phase !== "clawlore-candidate-duplicate-soft-archive-live-apply"
        || apply.status !== "applied"
        || apply.planDigest !== plan.planDigest
        || apply.planSha256 !== loadedPlan.sha256
        || apply.archive.targetGroups !== TARGET_GROUPS
        || apply.archive.targetRows !== TARGET_ROWS
        || apply.archive.candidateRowsArchived !== TARGET_ROWS
        || apply.archive.currentContentRowsChanged !== 0
        || apply.archive.currentVerificationRowsChanged !== 0
        || apply.archive.addressRowsChanged !== 0
        || apply.archive.aclRowsChanged !== 0
        || apply.archive.nonTargetRowsChanged !== 0
        || Object.values(apply.projections).some((value) => value !== 0)
        || apply.database.integrity !== "ok"
        || apply.database.foreignKeyViolations !== 0)
        throw new Error("duplicate archive apply receipt is invalid or outside the exact lane");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const source = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(source, apply.sourceAfter)) {
            throw new Error("live source no longer matches the duplicate archive apply receipt");
        }
        const archived = candidateRows(db, "archived");
        const byHash = new Map(archived.map((row) => [hash(row.item_id), row]));
        let archivedRows = 0;
        let validDispositionReceiptRows = 0;
        let supersedesRelationRows = 0;
        let archivedEventRows = 0;
        let projectionBindingRows = 0;
        const archivedGroupDigests = new Set();
        for (const planned of plan.rows) {
            const row = byHash.get(planned.itemIdSha256);
            if (!row
                || row.lifecycle !== "archived"
                || row.verification !== "unverified"
                || hash(row.content) !== planned.contentDigest
                || row.category !== planned.category)
                throw new Error("duplicate archive postcheck archived row is invalid");
            archivedRows += 1;
            archivedGroupDigests.add(planned.normalizedContentDigest);
            const evidence = parseRecord(row.evidence_json);
            const receipt = evidence.duplicateTraceDispositionReceiptV1;
            if (receipt?.rolloutId !== apply.rolloutId
                || receipt.planDigest !== plan.planDigest
                || receipt.normalizedContentDigest !== planned.normalizedContentDigest
                || receipt.archivedContentDigest !== planned.contentDigest
                || receipt.sourceLineageReceiptDigest !== planned.sourceLineageReceiptDigest
                || receipt.basis !== planned.basis
                || receipt.evidenceDigest !== planned.evidenceDigest
                || receipt.preservesContent !== true
                || receipt.preservesVerification !== true
                || receipt.preservesAddress !== true
                || receipt.preservesProjections !== true)
                throw new Error("duplicate archive postcheck disposition receipt is invalid");
            validDispositionReceiptRows += 1;
            const relations = scalar(db, `SELECT COUNT(*) FROM memory_relations
        WHERE from_revision_id=? AND relation_type='supersedes'`, row.current_revision_id);
            if (relations !== 1)
                throw new Error("duplicate archive postcheck supersedes relation is invalid");
            supersedesRelationRows += relations;
            const events = scalar(db, `SELECT COUNT(*) FROM memory_events
        WHERE item_id=? AND revision_id=? AND event_type='archived' AND reason=?`, row.item_id, row.current_revision_id, apply.rolloutId);
            if (events !== 1)
                throw new Error("duplicate archive postcheck event is invalid");
            archivedEventRows += events;
            const projections = [
                scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2 WHERE item_id=?", row.item_id),
                scalar(db, "SELECT COUNT(*) FROM memory_fts_v2 WHERE item_id=?", row.item_id),
                scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2 WHERE item_id=?", row.item_id),
                scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2 WHERE item_id=?", row.item_id),
            ];
            if (projections.some((count) => count !== 1))
                throw new Error("duplicate archive postcheck projection binding is invalid");
            projectionBindingRows += 1;
        }
        if (archivedGroupDigests.size !== TARGET_GROUPS)
            throw new Error("duplicate archive postcheck group coverage is incomplete");
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (integrity !== "ok" || foreignKeyViolations !== 0)
            throw new Error("duplicate archive postcheck database integrity failed");
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-duplicate-soft-archive-postcheck",
            verifiedAt: (input.now ?? (() => new Date()))().toISOString(),
            status: "pass",
            rolloutId: apply.rolloutId,
            planDigest: plan.planDigest,
            planSha256: loadedPlan.sha256,
            applyReceiptSha256: loadedApply.sha256,
            source,
            targetBinding: {
                archivedRows: TARGET_ROWS,
                archivedGroups: TARGET_GROUPS,
                validDispositionReceiptRows: TARGET_ROWS,
                supersedesRelationRows: TARGET_ROWS,
                archivedEventRows: TARGET_ROWS,
                projectionBindingRows: TARGET_ROWS,
                mismatches: 0,
            },
            database: { integrity: "ok", foreignKeyViolations: 0 },
            runtime: apply.runtime,
        };
    }
    finally {
        db.close();
    }
}
