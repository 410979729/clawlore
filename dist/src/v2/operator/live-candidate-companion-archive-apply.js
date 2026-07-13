import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { normalizeCandidateContentV1, validateSourceLineageReceiptV1, } from "../application/candidate-content-quality-review.js";
import { companionDispositionSourceStateV1, sameCompanionDispositionSourceV1, validateLiveCandidateCompanionDispositionPlanV1, } from "./live-candidate-companion-disposition.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function privateBytes(path, maximumBytes) {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > maximumBytes) {
        throw new Error("companion archive control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    return { bytes, sha256: hash(bytes) };
}
function privateJson(path, maximumBytes = CONTROL_MAX_BYTES) {
    const loaded = privateBytes(path, maximumBytes);
    const value = JSON.parse(loaded.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("companion archive control JSON is invalid");
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
function candidateRows(db) {
    return db.prepare(`SELECT i.item_id,i.current_revision_id,i.revision_no,i.content,i.category,
    i.address_json,i.lifecycle,i.verification,i.valid_until,l.metadata,
    s.source_id,s.source_type,s.external_id,s.observed_at,s.evidence_json
    FROM memory_items i JOIN memory_truth l ON i.item_id='legacy:' || l.id
    JOIN memory_sources s ON s.source_id=(SELECT s2.source_id FROM memory_sources s2
      WHERE s2.revision_id=i.current_revision_id ORDER BY s2.source_id LIMIT 1)
    WHERE i.lifecycle='candidate' ORDER BY i.item_id`).all();
}
function assertCompanionMatches(row, planned) {
    const metadata = parseRecord(row.metadata);
    const evidence = parseRecord(row.evidence_json);
    const lineage = evidence.sourceLineageReceiptV1;
    if (row.lifecycle !== "candidate"
        || row.verification !== "unverified"
        || hash(row.item_id) !== planned.companionItemIdSha256
        || hash(row.current_revision_id) !== planned.companionCurrentRevisionIdSha256
        || hash(row.content) !== planned.companionContentDigest
        || hash(normalizeCandidateContentV1(row.content)) !== planned.companionNormalizedContentDigest
        || row.category !== planned.category
        || !validateSourceLineageReceiptV1(lineage, classification(metadata, evidence))
        || hash(JSON.stringify(lineage)) !== planned.companionSourceLineageReceiptDigest)
        throw new Error("companion archive target no longer matches the accepted disposition");
}
function validateAcceptance(value, plan, planSha256) {
    if (value?.schemaVersion !== 1
        || value.phase !== "clawlore-candidate-companion-disposition-acceptance"
        || value.status !== "pass"
        || value.planDigest !== plan.planDigest
        || value.planSha256 !== planSha256
        || JSON.stringify(value.summary) !== JSON.stringify(plan.summary)
        || !sameCompanionDispositionSourceV1(value.live, plan.source)
        || value.liveBindingMismatches !== 0
        || value.decisionEvidenceMismatches !== 0
        || value.rawTraceOrIdentifierLeak !== false
        || value.authorizesSoftArchive !== false
        || value.authorizesLifecycleMutation !== false
        || value.requiresFreshEncryptedSnapshot !== true
        || value.requiresSeparateExactApply !== true)
        throw new Error("companion disposition acceptance is invalid or unbound");
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
        candidateRows: before.candidateRows - 3,
        archivedRows: before.archivedRows + 3,
    };
}
export async function executeLiveCandidateCompanionArchiveV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.rolloutId))
        throw new Error("companion archive rollout id is invalid");
    const appliedAtDate = input.now?.() ?? new Date();
    const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
    if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
        throw new Error("maximum snapshot age must be a positive integer");
    }
    const loadedPlan = privateJson(input.planPath);
    const plan = validateLiveCandidateCompanionDispositionPlanV1(loadedPlan.value, input.planDigest);
    const loadedAcceptance = privateJson(input.dispositionAcceptancePath);
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
        throw new Error("live source no longer matches the companion disposition plan");
    }
    const candidates = candidateRows(db);
    if (candidates.length !== beforeSource.candidateRows) {
        db.close();
        throw new Error("companion archive candidate mapping is incomplete");
    }
    const byHash = new Map(candidates.map((row) => [hash(row.item_id), row]));
    for (const planned of plan.rows) {
        const live = byHash.get(planned.companionItemIdSha256);
        if (!live) {
            db.close();
            throw new Error("companion archive target mapping is incomplete");
        }
        assertCompanionMatches(live, planned);
    }
    const targetItemIds = plan.rows.map((planned) => byHash.get(planned.companionItemIdSha256).item_id).sort();
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
            throw new Error("live source drifted before companion archive transaction");
        }
        const transactionCandidates = new Map(candidateRows(db).map((row) => [hash(row.item_id), row]));
        for (const planned of plan.rows) {
            const live = transactionCandidates.get(planned.companionItemIdSha256);
            if (!live)
                throw new Error("companion archive target disappeared before transaction");
            assertCompanionMatches(live, planned);
            const revisionId = randomUUID();
            const oldEvidence = parseRecord(live.evidence_json);
            const evidence = {
                ...oldEvidence,
                companionDispositionReceiptV1: {
                    schemaVersion: 1,
                    rolloutId: input.rolloutId,
                    planDigest: plan.planDigest,
                    factKey: planned.factKey,
                    representativeItemIdSha256: planned.representativeItemIdSha256,
                    representativeCurrentRevisionIdSha256: planned.representativeCurrentRevisionIdSha256,
                    representativeRewriteReceiptDigest: planned.representativeRewriteReceiptDigest,
                    archivedContentDigest: planned.companionContentDigest,
                    sourceLineageReceiptDigest: planned.companionSourceLineageReceiptDigest,
                    reason: planned.basis,
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
                throw new Error("companion archive current revision supersession failed closed");
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
        VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), live.item_id, revisionId, "archived", "operator:bounded-companion-disposition", input.rolloutId, appliedAt);
            const current = db.prepare(`UPDATE memory_items SET current_revision_id=?,revision_no=?,lifecycle='archived',updated_at=?
        WHERE item_id=? AND lifecycle='candidate' AND verification='unverified'`).run(revisionId, Number(live.revision_no) + 1, appliedAt, live.item_id);
            if (Number(current.changes) !== 1)
                throw new Error("companion archive current item update failed closed");
        }
        db.prepare(`INSERT INTO clawlore_rollouts_v2
      (rollout_id,plan_digest,control_sha256,readiness_sha256,legacy_logical_digest,rows_applied,
       applied_at,v1_fallback_reads,context_engine_enabled,final_recall_cutover_enabled)
      VALUES (?,?,?,?,?,?,?,1,0,0)`).run(input.rolloutId, plan.planDigest, loadedPlan.sha256, snapshot.sha256, legacyBefore.memoryTruth.logicalDigest, 3, appliedAt);
        const after = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(after, expectedAfter(beforeSource))
            || nonTargetDigest(db, targetItemIds) !== beforeNonTargetDigest
            || targetProtectedDigest(db, targetItemIds) !== beforeProtectedDigest
            || scalar(db, "SELECT COUNT(*) FROM memory_revisions") !== beforeCounts.revisions + 3
            || scalar(db, "SELECT COUNT(*) FROM memory_sources") !== beforeCounts.sources + 3
            || scalar(db, "SELECT COUNT(*) FROM memory_relations") !== beforeCounts.relations + 3
            || scalar(db, "SELECT COUNT(*) FROM memory_events") !== beforeCounts.events + 3
            || scalar(db, "SELECT COUNT(*) FROM projection_outbox") !== beforeCounts.outbox
            || scalar(db, "SELECT COUNT(*) FROM clawlore_rollouts_v2") !== beforeCounts.rollouts + 1)
            throw new Error("companion archive transaction exceeded the exact three-row boundary");
        const archived = targetItemIds.map((itemId) => db.prepare(`SELECT i.item_id,i.lifecycle,i.verification,i.content,
      i.current_revision_id,r.lifecycle AS revision_lifecycle,r.verification AS revision_verification,s.evidence_json
      FROM memory_items i JOIN memory_revisions r ON r.revision_id=i.current_revision_id
      JOIN memory_sources s ON s.revision_id=i.current_revision_id WHERE i.item_id=?`).get(itemId));
        if (archived.some((row) => {
            const evidence = parseRecord(String(row.evidence_json));
            const receipt = evidence.companionDispositionReceiptV1;
            return row.lifecycle !== "archived"
                || row.verification !== "unverified"
                || row.revision_lifecycle !== "archived"
                || row.revision_verification !== "unverified"
                || receipt?.planDigest !== plan.planDigest
                || receipt?.preservesContent !== true
                || receipt?.preservesProjections !== true;
        }))
            throw new Error("companion archive current revision acceptance failed");
        const supersededRows = plan.rows.filter((planned) => {
            const live = transactionCandidates.get(planned.companionItemIdSha256);
            const row = db.prepare("SELECT lifecycle FROM memory_revisions WHERE revision_id=?").get(live.current_revision_id);
            return row?.lifecycle === "superseded";
        }).length;
        if (supersededRows !== 3)
            throw new Error("companion archive historical supersession is incomplete");
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (integrity !== "ok" || foreignKeyViolations !== 0)
            throw new Error("companion archive database integrity failed");
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
        throw new Error("companion archive post-commit acceptance failed");
    return {
        schemaVersion: 1,
        phase: "clawlore-candidate-companion-soft-archive-live-apply",
        rolloutId: input.rolloutId,
        status: "applied",
        appliedAt,
        planDigest: plan.planDigest,
        planSha256: loadedPlan.sha256,
        dispositionAcceptanceSha256: loadedAcceptance.sha256,
        snapshotReceiptSha256: snapshot.sha256,
        snapshotArchiveSha256: snapshot.archiveSha256,
        sourceBefore: beforeSource,
        sourceAfter: afterSource,
        archive: {
            targetRows: 3,
            candidateRowsArchived: 3,
            newArchivedRevisionRows: 3,
            oldRevisionRowsSuperseded: 3,
            newSourceRows: 3,
            newRelationRows: 3,
            newEventRows: 3,
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
export function inspectLiveCandidateCompanionArchiveV1(input) {
    const loadedPlan = privateJson(input.planPath);
    const plan = validateLiveCandidateCompanionDispositionPlanV1(loadedPlan.value, input.planDigest);
    const loadedApply = privateJson(input.applyReceiptPath);
    const apply = loadedApply.value;
    if (apply?.schemaVersion !== 1
        || apply.phase !== "clawlore-candidate-companion-soft-archive-live-apply"
        || apply.status !== "applied"
        || apply.planDigest !== plan.planDigest
        || apply.planSha256 !== loadedPlan.sha256
        || apply.archive.targetRows !== 3
        || apply.archive.candidateRowsArchived !== 3
        || apply.archive.currentContentRowsChanged !== 0
        || apply.archive.currentVerificationRowsChanged !== 0
        || apply.archive.addressRowsChanged !== 0
        || apply.archive.aclRowsChanged !== 0
        || apply.archive.nonTargetRowsChanged !== 0
        || Object.values(apply.projections).some((value) => value !== 0)
        || apply.database.integrity !== "ok"
        || apply.database.foreignKeyViolations !== 0)
        throw new Error("companion archive apply receipt is invalid or outside the exact three-row lane");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const source = companionDispositionSourceStateV1(db);
        if (!sameCompanionDispositionSourceV1(source, apply.sourceAfter)) {
            throw new Error("live source no longer matches the companion archive apply receipt");
        }
        const allRows = db.prepare(`SELECT i.item_id,i.current_revision_id,i.content,i.category,i.lifecycle,i.verification,
      r.lifecycle AS revision_lifecycle,r.verification AS revision_verification,
      COALESCE((SELECT s.evidence_json FROM memory_sources s WHERE s.revision_id=i.current_revision_id
        ORDER BY s.source_id LIMIT 1),'{}') AS evidence_json
      FROM memory_items i JOIN memory_revisions r ON r.revision_id=i.current_revision_id`).all();
        const byHash = new Map(allRows.map((row) => [hash(String(row.item_id)), row]));
        let archivedCompanionRows = 0;
        let preservedRepresentativeRows = 0;
        let validDispositionReceiptRows = 0;
        let supersedesRelationRows = 0;
        let archivedEventRows = 0;
        let projectionBindingRows = 0;
        for (const planned of plan.rows) {
            const companion = byHash.get(planned.companionItemIdSha256);
            const representative = byHash.get(planned.representativeItemIdSha256);
            if (!companion || !representative)
                throw new Error("companion archive postcheck target mapping is incomplete");
            if (companion.lifecycle !== "archived"
                || companion.verification !== "unverified"
                || companion.revision_lifecycle !== "archived"
                || companion.revision_verification !== "unverified"
                || hash(String(companion.content)) !== planned.companionContentDigest
                || String(companion.category) !== planned.category)
                throw new Error("companion archive postcheck archived row is invalid");
            archivedCompanionRows += 1;
            if (representative.lifecycle !== "candidate"
                || representative.verification !== "unverified"
                || hash(String(representative.current_revision_id)) !== planned.representativeCurrentRevisionIdSha256
                || hash(String(representative.content)) !== planned.representativeContentDigest)
                throw new Error("companion archive postcheck representative was not preserved");
            preservedRepresentativeRows += 1;
            const evidence = parseRecord(String(companion.evidence_json));
            const disposition = evidence.companionDispositionReceiptV1;
            if (disposition?.rolloutId !== apply.rolloutId
                || disposition.planDigest !== plan.planDigest
                || disposition.factKey !== planned.factKey
                || disposition.representativeItemIdSha256 !== planned.representativeItemIdSha256
                || disposition.representativeCurrentRevisionIdSha256 !== planned.representativeCurrentRevisionIdSha256
                || disposition.representativeRewriteReceiptDigest !== planned.representativeRewriteReceiptDigest
                || disposition.archivedContentDigest !== planned.companionContentDigest
                || disposition.sourceLineageReceiptDigest !== planned.companionSourceLineageReceiptDigest
                || disposition.preservesContent !== true
                || disposition.preservesVerification !== true
                || disposition.preservesAddress !== true
                || disposition.preservesProjections !== true)
                throw new Error("companion archive postcheck disposition receipt is invalid");
            validDispositionReceiptRows += 1;
            const relation = scalar(db, `SELECT COUNT(*) FROM memory_relations
        WHERE from_revision_id=? AND relation_type='supersedes'`, String(companion.current_revision_id));
            if (relation !== 1)
                throw new Error("companion archive postcheck supersedes relation is invalid");
            supersedesRelationRows += relation;
            const events = scalar(db, `SELECT COUNT(*) FROM memory_events
        WHERE item_id=? AND revision_id=? AND event_type='archived' AND reason=?`, String(companion.item_id), String(companion.current_revision_id), apply.rolloutId);
            if (events !== 1)
                throw new Error("companion archive postcheck archived event is invalid");
            archivedEventRows += events;
            const projections = [
                scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2 WHERE item_id=?", String(companion.item_id)),
                scalar(db, "SELECT COUNT(*) FROM memory_fts_v2 WHERE item_id=?", String(companion.item_id)),
                scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2 WHERE item_id=?", String(companion.item_id)),
                scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2 WHERE item_id=?", String(companion.item_id)),
            ];
            if (projections.some((count) => count !== 1))
                throw new Error("companion archive postcheck projection binding is invalid");
            projectionBindingRows += 1;
        }
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (integrity !== "ok" || foreignKeyViolations !== 0)
            throw new Error("companion archive postcheck database integrity failed");
        return {
            schemaVersion: 1,
            phase: "clawlore-candidate-companion-soft-archive-postcheck",
            verifiedAt: (input.now ?? (() => new Date()))().toISOString(),
            status: "pass",
            rolloutId: apply.rolloutId,
            planDigest: plan.planDigest,
            planSha256: loadedPlan.sha256,
            applyReceiptSha256: loadedApply.sha256,
            source,
            targetBinding: {
                archivedCompanionRows: 3,
                preservedRepresentativeRows: 3,
                validDispositionReceiptRows: 3,
                supersedesRelationRows: 3,
                archivedEventRows: 3,
                projectionBindingRows: 3,
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
