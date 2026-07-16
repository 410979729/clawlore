import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { evaluateCaptureSafety } from "../../capture-safety.js";
import { normalizeCandidateContentV1, validateSourceLineageReceiptV1, } from "../application/candidate-content-quality-review.js";
import { validateLiveCandidateUnsafeTraceRewriteProposalPlanV1, } from "./live-candidate-unsafe-trace-rewrite-proposal.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;
const EXPECTED_TARGET_ROWS = 32;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isDigest(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function privateBytes(path, maximumBytes) {
    if (process.platform === "win32")
        preparePrivateFileForRead(path);
    const info = statSync(path);
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size <= 0 || info.size > maximumBytes) {
        throw new Error("unsafe trace rewrite apply control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    return { bytes, sha256: hash(bytes) };
}
function privateJson(path, maximumBytes = CONTROL_MAX_BYTES) {
    const loaded = privateBytes(path, maximumBytes);
    const value = JSON.parse(loaded.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("unsafe trace rewrite apply control JSON is invalid");
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
    const row = db.prepare(sql).get(...args);
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
function comparableSource(value) {
    return {
        v1Rows: value.v1Rows,
        v2Rows: value.v2Rows,
        candidateRows: value.candidateRows,
        activeRows: value.activeRows,
        archivedRows: value.archivedRows,
        compatibilityRows: value.compatibilityRows,
        currentFtsRows: value.currentFtsRows,
        vectorRows: value.vectorRows,
        relationRows: value.relationRows,
        pendingOutboxRows: value.pendingOutboxRows,
    };
}
function sameSource(left, right) {
    return JSON.stringify(comparableSource(left)) === JSON.stringify(comparableSource(right));
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
function validatePayload(value, sha256, plan) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-unsafe-trace-rewrite-payload"
        || value.readOnly !== true
        || value.containsProposedMemoryContent !== true
        || value.containsOriginalMemoryContent !== false
        || value.containsTranscriptContent !== false
        || value.containsRawIdentifiers !== false
        || value.authorizesContentRewrite !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesHardDelete !== false
        || value.authorizesLifecycleMutation !== false
        || value.authorizesVerificationMutation !== false
        || !Array.isArray(value.specifications)
        || value.specifications.length !== EXPECTED_TARGET_ROWS
        || value.payloadDigest !== plan.rewritePayloadDigest
        || sha256 !== plan.rewritePayloadSha256)
        throw new Error("unsafe trace rewrite payload is invalid or unbound");
    const core = {
        dispositionPlanDigest: value.dispositionPlanDigest,
        dispositionPlanSha256: value.dispositionPlanSha256,
        archiveApplyReceiptSha256: value.archiveApplyReceiptSha256,
        archivePostcheckSha256: value.archivePostcheckSha256,
        specifications: value.specifications,
    };
    if (value.dispositionPlanDigest !== plan.dispositionPlanDigest
        || value.dispositionPlanSha256 !== plan.dispositionPlanSha256
        || value.archiveApplyReceiptSha256 !== plan.archiveApplyReceiptSha256
        || value.archivePostcheckSha256 !== plan.archivePostcheckSha256
        || hash(JSON.stringify(core)) !== value.payloadDigest)
        throw new Error("unsafe trace rewrite payload digest is invalid");
    return value;
}
function validateAcceptance(value, plan, planSha256, payload, payloadSha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-unsafe-trace-rewrite-proposal-acceptance"
        || value.status !== "pass"
        || value.planDigest !== plan.planDigest
        || value.planSha256 !== planSha256
        || value.rewritePayloadDigest !== payload.payloadDigest
        || value.rewritePayloadSha256 !== payloadSha256
        || value.archivePostcheckSha256 !== plan.archivePostcheckSha256
        || JSON.stringify(value.summary) !== JSON.stringify(plan.summary)
        || JSON.stringify(value.live) !== JSON.stringify(plan.source)
        || value.liveBindingMismatches !== 0
        || value.proposedContentLeak !== false
        || value.rawTraceOrIdentifierLeak !== false
        || value.authorizesContentRewrite !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesHardDelete !== false
        || value.authorizesLifecycleMutation !== false
        || value.authorizesVerificationMutation !== false
        || value.requiresFreshEncryptedSnapshot !== true
        || value.requiresSeparateExactApply !== true)
        throw new Error("unsafe trace rewrite proposal acceptance is invalid or unbound");
}
function validateBaseline(value, expectedDigest) {
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
        || value.source.v1Rows !== value.source.v2Rows
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
        || promotion.planDigest !== expectedDigest
        || promotion.planDigest !== hash(JSON.stringify(promotion.rows))
        || promotion.rows.length !== value.source.candidateRows
        || value.decision.automaticPromotionRows !== 0)
        throw new Error("candidate baseline is invalid, unconverged, or digest-mismatched");
    return value;
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
function candidateRows(db) {
    return db.prepare(`SELECT i.item_id,i.current_revision_id,i.revision_no,i.content,i.category,
    i.address_json,i.lifecycle,i.verification,i.valid_until,l.metadata,
    s.source_id,s.source_type,s.external_id,s.observed_at,s.evidence_json
    FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
    JOIN memory_sources s ON s.source_id=(SELECT s2.source_id FROM memory_sources s2
      WHERE s2.revision_id=i.current_revision_id ORDER BY s2.source_id LIMIT 1)
    WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all();
}
function assertTargetMatches(row, planned) {
    const metadata = parseRecord(row.metadata);
    const evidence = parseRecord(row.evidence_json);
    const lineage = evidence.sourceLineageReceiptV1;
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
        || !validateSourceLineageReceiptV1(lineage, classification(metadata, evidence))
        || hash(JSON.stringify(lineage)) !== planned.sourceLineageReceiptDigest)
        throw new Error("unsafe trace rewrite live target no longer matches the accepted proposal");
}
function exactSpecifications(payload, plan) {
    const specifications = new Map(payload.specifications.map((value) => [value.itemIdSha256, value]));
    if (specifications.size !== EXPECTED_TARGET_ROWS || plan.summary.proposedDurableRows !== EXPECTED_TARGET_ROWS) {
        throw new Error("unsafe trace rewrite exact materialization requires one final output per target");
    }
    for (const planned of plan.rows) {
        const specification = specifications.get(planned.itemIdSha256);
        if (!specification
            || specification.currentRevisionIdSha256 !== planned.currentRevisionIdSha256
            || specification.rewriteDesign !== planned.rewriteDesign
            || specification.proposedContents.length !== 1
            || planned.outputs.length !== 1
            || hash(specification.proposedContents[0]) !== planned.outputs[0].proposedContentDigest
            || hash(normalizeCandidateContentV1(specification.proposedContents[0]))
                !== planned.outputs[0].proposedNormalizedContentDigest
            || evaluateCaptureSafety(specification.proposedContents[0]).allowed !== true)
            throw new Error("unsafe trace rewrite specification is not the exact accepted one-output materialization");
    }
    return specifications;
}
function digestQuery(db, sql, args = []) {
    return hash(JSON.stringify(db.prepare(sql).all(...args)));
}
function nonTargetDigest(db, targetItemIds) {
    const placeholders = targetItemIds.map(() => "?").join(",");
    const parts = [
        digestQuery(db, `SELECT * FROM memory_items WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_revisions WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,revision_no`, targetItemIds),
        digestQuery(db, `SELECT s.* FROM memory_sources s JOIN memory_revisions r ON r.revision_id=s.revision_id
      WHERE r.item_id NOT IN (${placeholders}) ORDER BY r.item_id,s.source_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_acl WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,acl_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_events WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,event_id`, targetItemIds),
        digestQuery(db, `SELECT rel.* FROM memory_relations rel
      JOIN memory_revisions source_revision ON source_revision.revision_id=rel.from_revision_id
      JOIN memory_revisions target_revision ON target_revision.revision_id=rel.to_revision_id
      WHERE source_revision.item_id NOT IN (${placeholders})
        AND target_revision.item_id NOT IN (${placeholders}) ORDER BY rel.relation_id`, [...targetItemIds, ...targetItemIds]),
        digestQuery(db, `SELECT * FROM memory_fts_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_fts_compat_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_vector_projection_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, `SELECT * FROM memory_relation_projection_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, targetItemIds),
        digestQuery(db, "SELECT * FROM projection_outbox ORDER BY outbox_id"),
    ];
    return hash(JSON.stringify(parts));
}
function protectedTargetDigest(db, itemIds) {
    const placeholders = itemIds.map(() => "?").join(",");
    return hash(JSON.stringify([
        db.prepare(`SELECT item_id,category,address_json,tenant_id,principal_id,agent_id,visibility,retention,
      workspace_id,project_id,conversation_id,thread_id,customer_id,task_id,lifecycle,verification,
      valid_until,created_at FROM memory_items WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...itemIds),
        db.prepare(`SELECT * FROM memory_acl WHERE item_id IN (${placeholders}) ORDER BY item_id,acl_id`).all(...itemIds),
        db.prepare(`SELECT * FROM memory_fts_compat_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...itemIds),
        db.prepare(`SELECT * FROM memory_vector_projection_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...itemIds),
        db.prepare(`SELECT * FROM memory_relation_projection_v2 WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...itemIds),
    ]));
}
function runtimeBoundary() {
    return {
        v1FallbackReads: true,
        existingCandidateLifecycleMutationEnabled: false,
        contextEngineEnabled: false,
        promptMutationEnabled: false,
        finalRecallCutoverEnabled: false,
    };
}
export async function executeLiveCandidateUnsafeTraceRewriteV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.rolloutId)) {
        throw new Error("unsafe trace rewrite rollout id is invalid");
    }
    const appliedAtDate = input.now?.() ?? new Date();
    const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
    if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
        throw new Error("maximum snapshot age must be a positive integer");
    }
    const loadedPlan = privateJson(input.planPath);
    const plan = validateLiveCandidateUnsafeTraceRewriteProposalPlanV1(loadedPlan.value, input.planDigest);
    const loadedPayload = privateJson(input.payloadPath);
    const payload = validatePayload(loadedPayload.value, loadedPayload.sha256, plan);
    const loadedAcceptance = privateJson(input.proposalAcceptancePath);
    validateAcceptance(loadedAcceptance.value, plan, loadedPlan.sha256, payload, loadedPayload.sha256);
    const specifications = exactSpecifications(payload, plan);
    const loadedBaseline = privateJson(input.candidateBaselinePath);
    const baseline = validateBaseline(loadedBaseline.value, input.candidateBaselineDigest);
    if (!sameSource(baseline.source, plan.source)) {
        throw new Error("candidate baseline does not match the accepted unsafe trace rewrite source");
    }
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
    const beforeSource = sourceState(db);
    if (!sameSource(beforeSource, plan.source)) {
        db.close();
        throw new Error("live source no longer matches the accepted unsafe trace rewrite plan");
    }
    const currentCandidates = candidateRows(db);
    if (currentCandidates.length !== beforeSource.candidateRows) {
        db.close();
        throw new Error("unsafe trace rewrite candidate mapping is incomplete");
    }
    const byHash = new Map(currentCandidates.map((row) => [hash(row.item_id), row]));
    for (const planned of plan.rows) {
        const live = byHash.get(planned.itemIdSha256);
        if (!live) {
            db.close();
            throw new Error("unsafe trace rewrite target mapping is incomplete");
        }
        try {
            assertTargetMatches(live, planned);
        }
        catch (error) {
            db.close();
            throw error;
        }
    }
    const targetItemIds = plan.rows.map((planned) => byHash.get(planned.itemIdSha256).item_id).sort();
    const beforeNonTargetDigest = nonTargetDigest(db, targetItemIds);
    const beforeProtectedTargetDigest = protectedTargetDigest(db, targetItemIds);
    const beforeCounts = {
        revisions: scalar(db, "SELECT COUNT(*) FROM memory_revisions"),
        sources: scalar(db, "SELECT COUNT(*) FROM memory_sources"),
        relations: scalar(db, "SELECT COUNT(*) FROM memory_relations"),
        events: scalar(db, "SELECT COUNT(*) FROM memory_events"),
        rollouts: scalar(db, "SELECT COUNT(*) FROM clawlore_rollouts_v2"),
    };
    const appliedAt = appliedAtDate.toISOString();
    try {
        db.exec("BEGIN IMMEDIATE");
        if (!sameSource(sourceState(db), beforeSource)) {
            throw new Error("live source drifted before unsafe trace rewrite transaction");
        }
        const transactionCandidates = new Map(candidateRows(db).map((row) => [hash(row.item_id), row]));
        for (const planned of plan.rows) {
            const live = transactionCandidates.get(planned.itemIdSha256);
            if (!live)
                throw new Error("unsafe trace rewrite target disappeared before transaction");
            assertTargetMatches(live, planned);
        }
        for (const planned of [...plan.rows].sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256))) {
            const live = transactionCandidates.get(planned.itemIdSha256);
            const specification = specifications.get(planned.itemIdSha256);
            const proposedContent = specification.proposedContents[0];
            const proposed = planned.outputs[0];
            const revisionId = randomUUID();
            const oldEvidence = parseRecord(live.evidence_json);
            const evidence = {
                ...oldEvidence,
                unsafeTraceRewriteReceiptV1: {
                    schemaVersion: 1,
                    rolloutId: input.rolloutId,
                    planDigest: plan.planDigest,
                    payloadDigest: payload.payloadDigest,
                    rewriteDesign: planned.rewriteDesign,
                    knowledgeCoverage: specification.knowledgeCoverage,
                    knowledgeEvidenceDigest: specification.knowledgeEvidenceDigest,
                    previousContentDigest: planned.contentDigest,
                    rewrittenContentDigest: proposed.proposedContentDigest,
                    sourceLineageReceiptDigest: planned.sourceLineageReceiptDigest,
                    appliedAt,
                    preservesCurrentLifecycle: true,
                    preservesVerification: true,
                    preservesAddress: true,
                },
            };
            const superseded = db.prepare("UPDATE memory_revisions SET lifecycle='superseded' WHERE revision_id=? AND lifecycle='candidate'").run(live.current_revision_id);
            if (Number(superseded.changes) !== 1) {
                throw new Error("unsafe trace rewrite current revision supersession failed closed");
            }
            db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(revisionId, live.item_id, Number(live.revision_no) + 1, proposedContent, "candidate", "unverified", live.valid_until, appliedAt);
            db.prepare(`INSERT INTO memory_sources
        (source_id,revision_id,source_type,external_id,observed_at,evidence_json)
        VALUES (?,?,?,?,?,?)`).run(randomUUID(), revisionId, live.source_type, live.external_id, live.observed_at, JSON.stringify(evidence));
            db.prepare(`INSERT INTO memory_relations
        (relation_id,from_revision_id,to_revision_id,relation_type,created_at)
        VALUES (?,?,?,?,?)`).run(randomUUID(), revisionId, live.current_revision_id, "supersedes", appliedAt);
            db.prepare(`INSERT INTO memory_events
        (event_id,item_id,revision_id,event_type,actor,reason,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), live.item_id, revisionId, "corrected", "operator:bounded-unsafe-trace-rewrite", input.rolloutId, appliedAt);
            const current = db.prepare(`UPDATE memory_items SET current_revision_id=?,revision_no=?,content=?,updated_at=?
        WHERE item_id=? AND lifecycle='candidate' AND verification='unverified'`).run(revisionId, Number(live.revision_no) + 1, proposedContent, appliedAt, live.item_id);
            if (Number(current.changes) !== 1)
                throw new Error("unsafe trace rewrite current item update failed closed");
            const fts = db.prepare("UPDATE memory_fts_v2 SET content=?,category=? WHERE item_id=?")
                .run(proposedContent, live.category, live.item_id);
            if (Number(fts.changes) !== 1)
                throw new Error("unsafe trace rewrite current FTS update failed closed");
        }
        db.prepare(`INSERT INTO clawlore_rollouts_v2
      (rollout_id,plan_digest,control_sha256,readiness_sha256,legacy_logical_digest,rows_applied,
       applied_at,v1_fallback_reads,context_engine_enabled,final_recall_cutover_enabled)
      VALUES (?,?,?,?,?,?,?,1,0,0)`).run(input.rolloutId, plan.planDigest, loadedPlan.sha256, snapshot.sha256, legacyBefore.memoryTruth.logicalDigest, EXPECTED_TARGET_ROWS, appliedAt);
        if (!sameSource(sourceState(db), beforeSource)
            || nonTargetDigest(db, targetItemIds) !== beforeNonTargetDigest
            || protectedTargetDigest(db, targetItemIds) !== beforeProtectedTargetDigest
            || scalar(db, "SELECT COUNT(*) FROM memory_revisions") !== beforeCounts.revisions + EXPECTED_TARGET_ROWS
            || scalar(db, "SELECT COUNT(*) FROM memory_sources") !== beforeCounts.sources + EXPECTED_TARGET_ROWS
            || scalar(db, "SELECT COUNT(*) FROM memory_relations") !== beforeCounts.relations + EXPECTED_TARGET_ROWS
            || scalar(db, "SELECT COUNT(*) FROM memory_events") !== beforeCounts.events + EXPECTED_TARGET_ROWS
            || scalar(db, "SELECT COUNT(*) FROM clawlore_rollouts_v2") !== beforeCounts.rollouts + 1)
            throw new Error("unsafe trace rewrite transaction exceeded the exact 32-row boundary");
        const superseded = plan.rows.filter((planned) => {
            const live = transactionCandidates.get(planned.itemIdSha256);
            const row = db.prepare("SELECT lifecycle FROM memory_revisions WHERE revision_id=?").get(live.current_revision_id);
            return row?.lifecycle === "superseded";
        }).length;
        if (superseded !== EXPECTED_TARGET_ROWS) {
            throw new Error("unsafe trace rewrite historical supersession bookkeeping is incomplete");
        }
        const rewritten = targetItemIds.map((itemId) => db.prepare(`SELECT i.lifecycle,i.verification,
      r.lifecycle AS revision_lifecycle,r.verification AS revision_verification
      FROM memory_items i JOIN memory_revisions r ON r.revision_id=i.current_revision_id WHERE i.item_id=?`).get(itemId));
        if (rewritten.some((row) => row.lifecycle !== "candidate" || row.verification !== "unverified"
            || row.revision_lifecycle !== "candidate" || row.revision_verification !== "unverified")) {
            throw new Error("unsafe trace rewrite changed protected lifecycle or verification state");
        }
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (integrity !== "ok" || foreignKeyViolations !== 0)
            throw new Error("unsafe trace rewrite database integrity failed");
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
    const afterSource = sourceState(db);
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    db.close();
    const legacyAfter = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (!sameSource(afterSource, beforeSource)
        || legacyAfter.memoryTruth.rowCount !== legacyBefore.memoryTruth.rowCount
        || legacyAfter.memoryTruth.logicalDigest !== legacyBefore.memoryTruth.logicalDigest
        || integrity !== "ok"
        || foreignKeyViolations !== 0)
        throw new Error("unsafe trace rewrite post-commit acceptance failed");
    return {
        schemaVersion: 1,
        phase: "clawlore-candidate-unsafe-trace-rewrite-live-apply",
        rolloutId: input.rolloutId,
        status: "applied",
        appliedAt,
        planDigest: plan.planDigest,
        planSha256: loadedPlan.sha256,
        payloadDigest: payload.payloadDigest,
        payloadSha256: loadedPayload.sha256,
        proposalAcceptanceSha256: loadedAcceptance.sha256,
        candidateBaselineDigest: input.candidateBaselineDigest,
        candidateBaselineSha256: loadedBaseline.sha256,
        snapshotReceiptSha256: snapshot.sha256,
        snapshotArchiveSha256: snapshot.archiveSha256,
        protectedNonTargetDigest: beforeNonTargetDigest,
        protectedTargetStateDigest: beforeProtectedTargetDigest,
        source: { ...afterSource, unchangedDuringApply: true },
        rewrite: {
            targetRows: 32,
            proposedOutputRows: 32,
            newRevisionRows: 32,
            oldRevisionRowsSuperseded: 32,
            newSourceRows: 32,
            newRelationRows: 32,
            newEventRows: 32,
            currentContentRowsChanged: 32,
            currentLifecycleRowsChanged: 0,
            currentVerificationRowsChanged: 0,
            addressRowsChanged: 0,
            aclRowsChanged: 0,
            nonTargetRowsChanged: 0,
        },
        projections: {
            currentFtsRowsChanged: 32,
            compatibilityRowsChanged: 0,
            vectorRowsChanged: 0,
            relationProjectionRowsChanged: 0,
            pendingOutboxRowsChanged: 0,
        },
        database: { integrity: "ok", foreignKeyViolations: 0 },
        runtime: runtimeBoundary(),
    };
}
function validateApplyReceipt(value, plan, planSha256, payload, payloadSha256, acceptanceSha256, expectedRolloutId) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-unsafe-trace-rewrite-live-apply"
        || value.status !== "applied"
        || value.rolloutId !== expectedRolloutId
        || value.planDigest !== plan.planDigest
        || value.planSha256 !== planSha256
        || value.payloadDigest !== payload.payloadDigest
        || value.payloadSha256 !== payloadSha256
        || value.proposalAcceptanceSha256 !== acceptanceSha256
        || !isDigest(value.protectedNonTargetDigest)
        || !isDigest(value.protectedTargetStateDigest)
        || value.rewrite.targetRows !== 32
        || value.rewrite.proposedOutputRows !== 32
        || value.rewrite.newRevisionRows !== 32
        || value.rewrite.oldRevisionRowsSuperseded !== 32
        || value.rewrite.newSourceRows !== 32
        || value.rewrite.newRelationRows !== 32
        || value.rewrite.newEventRows !== 32
        || value.rewrite.currentContentRowsChanged !== 32
        || value.rewrite.currentLifecycleRowsChanged !== 0
        || value.rewrite.currentVerificationRowsChanged !== 0
        || value.rewrite.addressRowsChanged !== 0
        || value.rewrite.aclRowsChanged !== 0
        || value.rewrite.nonTargetRowsChanged !== 0
        || value.projections.currentFtsRowsChanged !== 32
        || value.projections.compatibilityRowsChanged !== 0
        || value.projections.vectorRowsChanged !== 0
        || value.projections.relationProjectionRowsChanged !== 0
        || value.projections.pendingOutboxRowsChanged !== 0
        || value.database.integrity !== "ok"
        || value.database.foreignKeyViolations !== 0
        || JSON.stringify(value.runtime) !== JSON.stringify(runtimeBoundary()))
        throw new Error("unsafe trace rewrite apply receipt is invalid or outside the exact lane");
}
export function createLiveCandidateUnsafeTraceRewritePostcheckV1(input) {
    const loadedPlan = privateJson(input.planPath);
    const plan = validateLiveCandidateUnsafeTraceRewriteProposalPlanV1(loadedPlan.value, input.planDigest);
    const loadedPayload = privateJson(input.payloadPath);
    const payload = validatePayload(loadedPayload.value, loadedPayload.sha256, plan);
    const loadedAcceptance = privateJson(input.proposalAcceptancePath);
    validateAcceptance(loadedAcceptance.value, plan, loadedPlan.sha256, payload, loadedPayload.sha256);
    const specifications = exactSpecifications(payload, plan);
    const loadedApply = privateJson(input.applyReceiptPath);
    validateApplyReceipt(loadedApply.value, plan, loadedPlan.sha256, payload, loadedPayload.sha256, loadedAcceptance.sha256, input.rolloutId);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
    try {
        const liveSource = sourceState(db);
        if (!sameSource(liveSource, loadedApply.value.source)) {
            throw new Error("unsafe trace rewrite postcheck source no longer matches the apply receipt");
        }
        const candidates = candidateRows(db);
        if (candidates.length !== liveSource.candidateRows) {
            throw new Error("unsafe trace rewrite postcheck candidate mapping is incomplete");
        }
        const byHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
        const targetItemIds = plan.rows.map((planned) => {
            const row = byHash.get(planned.itemIdSha256);
            if (!row)
                throw new Error("unsafe trace rewrite postcheck target mapping is incomplete");
            return row.item_id;
        }).sort();
        if (nonTargetDigest(db, targetItemIds) !== loadedApply.value.protectedNonTargetDigest
            || protectedTargetDigest(db, targetItemIds) !== loadedApply.value.protectedTargetStateDigest)
            throw new Error("unsafe trace rewrite postcheck detected protected-state drift");
        let candidateRowsCount = 0;
        let unverifiedRows = 0;
        let supersededRevisionRows = 0;
        let validRewriteReceiptRows = 0;
        let supersedesRelationRows = 0;
        let correctedEventRows = 0;
        let currentFtsRows = 0;
        let preservedCompatibilityRows = 0;
        let preservedVectorRows = 0;
        let preservedRelationProjectionRows = 0;
        for (const planned of plan.rows) {
            const live = byHash.get(planned.itemIdSha256);
            const specification = specifications.get(planned.itemIdSha256);
            const proposedContent = specification.proposedContents[0];
            if (live.lifecycle !== "candidate"
                || live.verification !== "unverified"
                || hash(live.content) !== planned.outputs[0].proposedContentDigest
                || hash(normalizeCandidateContentV1(live.content)) !== planned.outputs[0].proposedNormalizedContentDigest)
                throw new Error("unsafe trace rewrite postcheck found a current target mismatch");
            candidateRowsCount += 1;
            unverifiedRows += 1;
            const revisions = db.prepare("SELECT revision_id,lifecycle FROM memory_revisions WHERE item_id=?").all(live.item_id);
            const oldRevision = revisions.find((revision) => hash(revision.revision_id) === planned.currentRevisionIdSha256);
            if (!oldRevision || oldRevision.lifecycle !== "superseded") {
                throw new Error("unsafe trace rewrite postcheck found incomplete historical supersession");
            }
            supersededRevisionRows += 1;
            const evidence = parseRecord(live.evidence_json);
            const receipt = evidence.unsafeTraceRewriteReceiptV1;
            if (receipt?.schemaVersion !== 1
                || receipt.rolloutId !== input.rolloutId
                || receipt.planDigest !== plan.planDigest
                || receipt.payloadDigest !== payload.payloadDigest
                || receipt.rewriteDesign !== planned.rewriteDesign
                || receipt.knowledgeCoverage !== specification.knowledgeCoverage
                || receipt.knowledgeEvidenceDigest !== specification.knowledgeEvidenceDigest
                || receipt.previousContentDigest !== planned.contentDigest
                || receipt.rewrittenContentDigest !== planned.outputs[0].proposedContentDigest
                || receipt.sourceLineageReceiptDigest !== planned.sourceLineageReceiptDigest
                || receipt.preservesCurrentLifecycle !== true
                || receipt.preservesVerification !== true
                || receipt.preservesAddress !== true)
                throw new Error("unsafe trace rewrite postcheck found an invalid rewrite receipt");
            validRewriteReceiptRows += 1;
            supersedesRelationRows += scalar(db, `SELECT COUNT(*) FROM memory_relations
        WHERE from_revision_id=? AND to_revision_id=? AND relation_type='supersedes'`, live.current_revision_id, oldRevision.revision_id);
            correctedEventRows += scalar(db, `SELECT COUNT(*) FROM memory_events
        WHERE item_id=? AND revision_id=? AND event_type='corrected'
          AND actor='operator:bounded-unsafe-trace-rewrite' AND reason=?`, live.item_id, live.current_revision_id, input.rolloutId);
            currentFtsRows += scalar(db, "SELECT COUNT(*) FROM memory_fts_v2 WHERE item_id=? AND content=? AND category=?", live.item_id, proposedContent, live.category);
            const compatibility = db.prepare("SELECT content FROM memory_fts_compat_v2 WHERE item_id=?").get(live.item_id);
            if (!compatibility || hash(compatibility.content) !== planned.contentDigest) {
                throw new Error("unsafe trace rewrite postcheck found compatibility projection drift");
            }
            preservedCompatibilityRows += 1;
            preservedVectorRows += scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2 WHERE item_id=?", live.item_id);
            preservedRelationProjectionRows += scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2 WHERE item_id=?", live.item_id);
        }
        const rollout = scalar(db, `SELECT COUNT(*) FROM clawlore_rollouts_v2
      WHERE rollout_id=? AND plan_digest=? AND rows_applied=? AND v1_fallback_reads=1
        AND context_engine_enabled=0 AND final_recall_cutover_enabled=0`, input.rolloutId, plan.planDigest, EXPECTED_TARGET_ROWS);
        if (candidateRowsCount !== 32
            || unverifiedRows !== 32
            || supersededRevisionRows !== 32
            || validRewriteReceiptRows !== 32
            || supersedesRelationRows !== 32
            || correctedEventRows !== 32
            || currentFtsRows !== 32
            || preservedCompatibilityRows !== 32
            || preservedVectorRows !== 32
            || preservedRelationProjectionRows !== 32
            || rollout !== 1)
            throw new Error("unsafe trace rewrite postcheck target binding is incomplete");
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (integrity !== "ok" || foreignKeyViolations !== 0) {
            throw new Error("unsafe trace rewrite postcheck database integrity failed");
        }
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-unsafe-trace-rewrite-postcheck",
            verifiedAt: (input.now?.() ?? new Date()).toISOString(),
            status: "pass",
            rolloutId: input.rolloutId,
            planDigest: plan.planDigest,
            planSha256: loadedPlan.sha256,
            applyReceiptSha256: loadedApply.sha256,
            source: liveSource,
            targetBinding: {
                rewrittenRows: 32,
                candidateRows: 32,
                unverifiedRows: 32,
                supersededRevisionRows: 32,
                validRewriteReceiptRows: 32,
                supersedesRelationRows: 32,
                correctedEventRows: 32,
                currentFtsRows: 32,
                preservedCompatibilityRows: 32,
                preservedVectorRows: 32,
                preservedRelationProjectionRows: 32,
                mismatches: 0,
            },
            protectedNonTargetDigest: loadedApply.value.protectedNonTargetDigest,
            protectedTargetStateDigest: loadedApply.value.protectedTargetStateDigest,
            database: { integrity: "ok", foreignKeyViolations: 0 },
            runtime: loadedApply.value.runtime,
        };
    }
    finally {
        db.close();
    }
}
