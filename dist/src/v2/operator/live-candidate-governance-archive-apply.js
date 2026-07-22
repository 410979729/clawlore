import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { companionDispositionSourceStateV1, sameCompanionDispositionSourceV1, } from "./live-candidate-companion-disposition.js";
import { GOVERNANCE_ARCHIVE_TARGET_ROWS, assertCandidateGovernanceLiveBindingV1, candidateGovernanceRowsByHashV1, candidateGovernanceSourceLogicalDigestV1, loadPrivateCandidateGovernanceControlV1, validateLiveCandidateGovernanceArchivePlanV1, } from "./live-candidate-governance-archive-plan.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
const require = createRequire(import.meta.url);
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function privateBytes(path, maximumBytes) {
    if (process.platform === "win32")
        preparePrivateFileForRead(path);
    const info = statSync(path);
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
        || info.size <= 0 || info.size > maximumBytes) {
        throw new Error("candidate governance archive input must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    return { bytes, sha256: hash(bytes) };
}
function privateJson(path, maximumBytes = 5 * 1024 * 1024) {
    const loaded = privateBytes(path, maximumBytes);
    const value = JSON.parse(loaded.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("candidate governance archive JSON input is invalid");
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
function validateAcceptance(value, plan, planSha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-governance-soft-archive-acceptance"
        || value.status !== "pass"
        || value.planDigest !== plan.planDigest
        || value.planSha256 !== planSha256
        || !sameCompanionDispositionSourceV1(value.source, plan.source)
        || value.sourceLogicalDigest !== plan.sourceLogicalDigest
        || JSON.stringify(value.summary) !== JSON.stringify(plan.summary)
        || value.liveBindingMismatches !== 0
        || value.rawTraceOrIdentifierLeak !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesLifecycleMutation !== false
        || value.requiresFreshEncryptedSnapshot !== true
        || value.requiresSeparateExactApply !== true)
        throw new Error("candidate governance archive acceptance is invalid or unbound");
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
    return {
        ...before,
        candidateRows: before.candidateRows - GOVERNANCE_ARCHIVE_TARGET_ROWS,
        archivedRows: before.archivedRows + GOVERNANCE_ARCHIVE_TARGET_ROWS,
    };
}
function runtimeState() {
    return {
        v1FallbackReads: false,
        existingCandidateLifecycleMutationEnabled: false,
        contextEngineEnabled: false,
        promptMutationEnabled: false,
        finalRecallCutoverEnabled: false,
    };
}
function allCurrentRows(db) {
    return db.prepare(`SELECT i.*,r.lifecycle AS revision_lifecycle,r.verification AS revision_verification,
    r.content AS revision_content,s.evidence_json
    FROM memory_items i JOIN memory_revisions r ON r.revision_id=i.current_revision_id
    JOIN memory_sources s ON s.source_id=(SELECT s2.source_id FROM memory_sources s2
      WHERE s2.revision_id=i.current_revision_id ORDER BY s2.source_id LIMIT 1)
    ORDER BY i.item_id`).all();
}
function principalDigest(row) {
    return hash(JSON.stringify({
        tenantId: row.tenant_id,
        principalId: row.principal_id,
        agentId: row.agent_id,
        visibility: row.visibility,
        retention: row.retention,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        conversationId: row.conversation_id,
        threadId: row.thread_id,
        customerId: row.customer_id,
        taskId: row.task_id,
    }));
}
function aclDigest(db, itemId) {
    return hash(JSON.stringify(db.prepare("SELECT * FROM memory_acl WHERE item_id=? ORDER BY acl_id").all(itemId)));
}
function verifyAppliedTargets(db, plan, rolloutId) {
    const byHash = new Map(allCurrentRows(db).map((row) => [hash(String(row.item_id)), row]));
    for (const planned of plan.rows) {
        const row = byHash.get(planned.itemIdSha256);
        if (!row
            || row.lifecycle !== "archived"
            || row.verification !== "unverified"
            || row.revision_lifecycle !== "archived"
            || row.revision_verification !== "unverified"
            || hash(String(row.content)) !== planned.contentDigest
            || hash(String(row.revision_content)) !== planned.contentDigest
            || String(row.category) !== planned.category
            || hash(String(row.address_json)) !== planned.addressDigest
            || principalDigest(row) !== planned.principalBindingDigest
            || aclDigest(db, String(row.item_id)) !== planned.aclDigest) {
            throw new Error("governance archive postcheck target content or policy binding is invalid");
        }
        const evidence = parseRecord(String(row.evidence_json));
        const receipt = evidence.governanceArchiveReceiptV1;
        if (receipt?.schemaVersion !== 1
            || receipt.rolloutId !== rolloutId
            || receipt.planDigest !== plan.planDigest
            || receipt.itemIdSha256 !== planned.itemIdSha256
            || receipt.previousRevisionIdSha256 !== planned.currentRevisionIdSha256
            || receipt.contentDigest !== planned.contentDigest
            || receipt.addressDigest !== planned.addressDigest
            || receipt.principalBindingDigest !== planned.principalBindingDigest
            || receipt.aclDigest !== planned.aclDigest
            || receipt.sourceEvidenceDigest !== planned.sourceEvidenceDigest
            || receipt.origin !== planned.origin
            || receipt.reason !== planned.reason
            || receipt.preservesContent !== true
            || receipt.preservesVerification !== true
            || receipt.preservesAddress !== true
            || receipt.preservesPrincipal !== true
            || receipt.preservesAcl !== true
            || receipt.preservesProjections !== true)
            throw new Error("governance archive receipt is invalid or unbound");
        const relation = db.prepare(`SELECT to_revision_id FROM memory_relations
      WHERE from_revision_id=? AND relation_type='supersedes'`).all(String(row.current_revision_id));
        if (relation.length !== 1 || hash(relation[0].to_revision_id) !== planned.currentRevisionIdSha256) {
            throw new Error("governance archive supersedes relation is invalid");
        }
        if (scalar(db, `SELECT COUNT(*) FROM memory_events WHERE item_id=? AND revision_id=?
      AND event_type='archived' AND reason=?`, String(row.item_id), String(row.current_revision_id), rolloutId) !== 1) {
            throw new Error("governance archive event is invalid");
        }
        const projections = [
            scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2 WHERE item_id=?", String(row.item_id)),
            scalar(db, "SELECT COUNT(*) FROM memory_fts_v2 WHERE item_id=?", String(row.item_id)),
            scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2 WHERE item_id=?", String(row.item_id)),
            scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2 WHERE item_id=?", String(row.item_id)),
        ];
        if (projections.some((count) => count !== 1))
            throw new Error("governance archive projection binding is invalid");
    }
    return {
        archivedRows: 112,
        validGovernanceReceiptRows: 112,
        supersedesRelationRows: 112,
        archivedEventRows: 112,
        projectionBindingRows: 112,
        preservedContentRows: 112,
        preservedVerificationRows: 112,
        preservedAddressRows: 112,
        preservedPrincipalRows: 112,
        preservedAclRows: 112,
        mismatches: 0,
    };
}
function validateDatabase(db) {
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    if (integrity !== "ok" || foreignKeyViolations !== 0)
        throw new Error("candidate governance archive database integrity failed");
    return { integrity: "ok", foreignKeyViolations: 0 };
}
function receipt(input) {
    return {
        schemaVersion: 1,
        phase: "clawlore-candidate-governance-soft-archive-live-apply",
        rolloutId: input.rolloutId,
        status: "applied",
        appliedAt: input.appliedAt,
        idempotentReplay: input.idempotentReplay,
        planDigest: input.plan.planDigest,
        planSha256: input.planSha256,
        acceptanceSha256: input.acceptanceSha256,
        snapshotReceiptSha256: input.snapshotReceiptSha256,
        snapshotArchiveSha256: input.snapshotArchiveSha256,
        sourceBefore: input.plan.source,
        sourceAfter: input.sourceAfter,
        sourceBeforeLogicalDigest: input.plan.sourceLogicalDigest,
        sourceAfterLogicalDigest: input.sourceAfterLogicalDigest,
        archive: {
            targetRows: 112,
            candidateRowsArchived: 112,
            rowsChangedThisRun: input.rowsChangedThisRun,
            newArchivedRevisionRows: 112,
            oldRevisionRowsSuperseded: 112,
            newSourceRows: 112,
            newRelationRows: 112,
            newEventRows: 112,
            currentContentRowsChanged: 0,
            currentVerificationRowsChanged: 0,
            addressRowsChanged: 0,
            principalRowsChanged: 0,
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
        runtime: runtimeState(),
    };
}
export async function executeLiveCandidateGovernanceArchiveV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.rolloutId))
        throw new Error("governance archive rollout id is invalid");
    const appliedAtDate = input.now?.() ?? new Date();
    const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
    if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0)
        throw new Error("maximum snapshot age must be positive");
    const loadedPlan = loadPrivateCandidateGovernanceControlV1(input.planPath);
    const plan = validateLiveCandidateGovernanceArchivePlanV1(loadedPlan.value, input.planDigest);
    const loadedAcceptance = loadPrivateCandidateGovernanceControlV1(input.acceptancePath);
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
        || legacyBefore.memoryTruth.logicalDigest !== snapshot.value.snapshot.memoryTruthLogicalDigest) {
        throw new Error("V1 truth no longer matches the fresh encrypted snapshot");
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
    try {
        const existing = db.prepare("SELECT * FROM clawlore_rollouts_v2 WHERE rollout_id=?").get(input.rolloutId);
        if (existing) {
            if (existing.plan_digest !== plan.planDigest || existing.control_sha256 !== loadedPlan.sha256
                || existing.readiness_sha256 !== snapshot.sha256 || Number(existing.rows_applied) !== GOVERNANCE_ARCHIVE_TARGET_ROWS) {
                throw new Error("existing governance archive rollout does not match this replay");
            }
            const sourceAfter = companionDispositionSourceStateV1(db);
            if (!sameCompanionDispositionSourceV1(sourceAfter, expectedAfter(plan.source))) {
                throw new Error("idempotent governance archive replay source state is invalid");
            }
            verifyAppliedTargets(db, plan, input.rolloutId);
            validateDatabase(db);
            return receipt({
                rolloutId: input.rolloutId,
                appliedAt: String(existing.applied_at),
                idempotentReplay: true,
                plan,
                planSha256: loadedPlan.sha256,
                acceptanceSha256: loadedAcceptance.sha256,
                snapshotReceiptSha256: snapshot.sha256,
                snapshotArchiveSha256: snapshot.archiveSha256,
                sourceAfter,
                sourceAfterLogicalDigest: candidateGovernanceSourceLogicalDigestV1(db),
                rowsChangedThisRun: 0,
            });
        }
        const sourceBefore = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(sourceBefore, plan.source)
            || candidateGovernanceSourceLogicalDigestV1(db) !== plan.sourceLogicalDigest) {
            throw new Error("live source no longer matches the governance archive plan");
        }
        const byHash = candidateGovernanceRowsByHashV1(db);
        for (const planned of plan.rows) {
            const live = byHash.get(planned.itemIdSha256);
            if (!live)
                throw new Error("governance archive target mapping is incomplete");
            assertCandidateGovernanceLiveBindingV1(db, planned, live);
        }
        const targetItemIds = plan.rows.map((planned) => String(byHash.get(planned.itemIdSha256).item_id)).sort();
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
            if (!sameCompanionDispositionSourceV1(companionDispositionSourceStateV1(db), sourceBefore)
                || candidateGovernanceSourceLogicalDigestV1(db) !== plan.sourceLogicalDigest) {
                throw new Error("source drifted before governance archive transaction");
            }
            const transactionRows = candidateGovernanceRowsByHashV1(db);
            for (const planned of plan.rows) {
                const live = transactionRows.get(planned.itemIdSha256);
                if (!live)
                    throw new Error("governance archive target disappeared before transaction");
                assertCandidateGovernanceLiveBindingV1(db, planned, live);
                const revisionId = randomUUID();
                const oldEvidence = parseRecord(live.evidence_json);
                const evidence = {
                    ...oldEvidence,
                    governanceArchiveReceiptV1: {
                        schemaVersion: 1,
                        rolloutId: input.rolloutId,
                        planDigest: plan.planDigest,
                        itemIdSha256: planned.itemIdSha256,
                        previousRevisionIdSha256: planned.currentRevisionIdSha256,
                        contentDigest: planned.contentDigest,
                        addressDigest: planned.addressDigest,
                        principalBindingDigest: planned.principalBindingDigest,
                        aclDigest: planned.aclDigest,
                        sourceEvidenceDigest: planned.sourceEvidenceDigest,
                        decisionEvidenceDigest: planned.decisionEvidenceDigest,
                        origin: planned.origin,
                        classification: planned.classification,
                        reason: planned.reason,
                        appliedAt,
                        preservesContent: true,
                        preservesVerification: true,
                        preservesAddress: true,
                        preservesPrincipal: true,
                        preservesAcl: true,
                        preservesProjections: true,
                    },
                };
                const superseded = db.prepare("UPDATE memory_revisions SET lifecycle='superseded' WHERE revision_id=? AND lifecycle='candidate'")
                    .run(live.current_revision_id);
                if (Number(superseded.changes) !== 1)
                    throw new Error("governance archive revision supersession failed closed");
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
          VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), live.item_id, revisionId, "archived", "operator:bounded-governance-archive", input.rolloutId, appliedAt);
                const current = db.prepare(`UPDATE memory_items SET current_revision_id=?,revision_no=?,lifecycle='archived',updated_at=?
          WHERE item_id=? AND current_revision_id=? AND lifecycle='candidate' AND verification='unverified'`).run(revisionId, Number(live.revision_no) + 1, appliedAt, live.item_id, live.current_revision_id);
                if (Number(current.changes) !== 1)
                    throw new Error("governance archive current item update failed closed");
            }
            db.prepare(`INSERT INTO clawlore_rollouts_v2
        (rollout_id,plan_digest,control_sha256,readiness_sha256,legacy_logical_digest,rows_applied,
         applied_at,v1_fallback_reads,context_engine_enabled,final_recall_cutover_enabled)
        VALUES (?,?,?,?,?,?,?,0,0,0)`).run(input.rolloutId, plan.planDigest, loadedPlan.sha256, snapshot.sha256, legacyBefore.memoryTruth.logicalDigest, GOVERNANCE_ARCHIVE_TARGET_ROWS, appliedAt);
            const after = companionDispositionSourceStateV1(db);
            if (!sameCompanionDispositionSourceV1(after, expectedAfter(sourceBefore))
                || nonTargetDigest(db, targetItemIds) !== beforeNonTargetDigest
                || targetProtectedDigest(db, targetItemIds) !== beforeProtectedDigest
                || scalar(db, "SELECT COUNT(*) FROM memory_revisions") !== beforeCounts.revisions + GOVERNANCE_ARCHIVE_TARGET_ROWS
                || scalar(db, "SELECT COUNT(*) FROM memory_sources") !== beforeCounts.sources + GOVERNANCE_ARCHIVE_TARGET_ROWS
                || scalar(db, "SELECT COUNT(*) FROM memory_relations") !== beforeCounts.relations + GOVERNANCE_ARCHIVE_TARGET_ROWS
                || scalar(db, "SELECT COUNT(*) FROM memory_events") !== beforeCounts.events + GOVERNANCE_ARCHIVE_TARGET_ROWS
                || scalar(db, "SELECT COUNT(*) FROM projection_outbox") !== beforeCounts.outbox
                || scalar(db, "SELECT COUNT(*) FROM clawlore_rollouts_v2") !== beforeCounts.rollouts + 1) {
                throw new Error("governance archive transaction exceeded the exact 112-row boundary");
            }
            verifyAppliedTargets(db, plan, input.rolloutId);
            validateDatabase(db);
            db.exec("COMMIT");
        }
        catch (error) {
            try {
                db.exec("ROLLBACK");
            }
            catch { /* transaction may not be open */ }
            throw error;
        }
        const sourceAfter = companionDispositionSourceStateV1(db);
        const sourceAfterLogicalDigest = candidateGovernanceSourceLogicalDigestV1(db);
        validateDatabase(db);
        const legacyAfter = await inspectLegacySqliteSnapshotV2(input.sourcePath);
        if (!sameCompanionDispositionSourceV1(sourceAfter, expectedAfter(sourceBefore))
            || legacyAfter.memoryTruth.rowCount !== legacyBefore.memoryTruth.rowCount
            || legacyAfter.memoryTruth.logicalDigest !== legacyBefore.memoryTruth.logicalDigest) {
            throw new Error("governance archive post-commit V1 preservation check failed");
        }
        return receipt({
            rolloutId: input.rolloutId,
            appliedAt,
            idempotentReplay: false,
            plan,
            planSha256: loadedPlan.sha256,
            acceptanceSha256: loadedAcceptance.sha256,
            snapshotReceiptSha256: snapshot.sha256,
            snapshotArchiveSha256: snapshot.archiveSha256,
            sourceAfter,
            sourceAfterLogicalDigest,
            rowsChangedThisRun: 112,
        });
    }
    finally {
        db.close();
    }
}
export function inspectLiveCandidateGovernanceArchiveV1(input) {
    const loadedPlan = loadPrivateCandidateGovernanceControlV1(input.planPath);
    const plan = validateLiveCandidateGovernanceArchivePlanV1(loadedPlan.value, input.planDigest);
    const loadedApply = privateJson(input.applyReceiptPath);
    const apply = loadedApply.value;
    if (apply?.schemaVersion !== 1
        || apply.phase !== "clawlore-candidate-governance-soft-archive-live-apply"
        || apply.status !== "applied"
        || apply.planDigest !== plan.planDigest
        || apply.planSha256 !== loadedPlan.sha256
        || apply.archive.targetRows !== GOVERNANCE_ARCHIVE_TARGET_ROWS
        || apply.archive.candidateRowsArchived !== GOVERNANCE_ARCHIVE_TARGET_ROWS
        || apply.archive.currentContentRowsChanged !== 0
        || apply.archive.currentVerificationRowsChanged !== 0
        || apply.archive.addressRowsChanged !== 0
        || apply.archive.principalRowsChanged !== 0
        || apply.archive.aclRowsChanged !== 0
        || apply.archive.nonTargetRowsChanged !== 0
        || Object.values(apply.projections).some((value) => value !== 0)
        || apply.database.integrity !== "ok"
        || apply.database.foreignKeyViolations !== 0)
        throw new Error("governance archive apply receipt is invalid or outside the exact lane");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const source = companionDispositionSourceStateV1(db);
        const sourceLogicalDigest = candidateGovernanceSourceLogicalDigestV1(db);
        if (!sameCompanionDispositionSourceV1(source, apply.sourceAfter)
            || sourceLogicalDigest !== apply.sourceAfterLogicalDigest
            || !sameCompanionDispositionSourceV1(source, expectedAfter(plan.source))) {
            throw new Error("source no longer matches the governance archive apply receipt");
        }
        const targetBinding = verifyAppliedTargets(db, plan, apply.rolloutId);
        const database = validateDatabase(db);
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-governance-soft-archive-postcheck",
            verifiedAt: (input.now ?? (() => new Date()))().toISOString(),
            status: "pass",
            rolloutId: apply.rolloutId,
            planDigest: plan.planDigest,
            planSha256: loadedPlan.sha256,
            applyReceiptSha256: loadedApply.sha256,
            source,
            sourceLogicalDigest,
            targetBinding,
            database,
            runtime: apply.runtime,
        };
    }
    finally {
        db.close();
    }
}
