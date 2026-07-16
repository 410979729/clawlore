import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { normalizeCandidateContentV1, validateSourceLineageReceiptV1, } from "../application/candidate-content-quality-review.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;
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
        throw new Error("durable rewrite apply control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    return { bytes, sha256: hash(bytes) };
}
function privateJson(path, maximumBytes = CONTROL_MAX_BYTES) {
    const loaded = privateBytes(path, maximumBytes);
    const value = JSON.parse(loaded.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("durable rewrite apply control JSON is invalid");
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
function appendOnlyExtension(current, baseline) {
    const delta = current.v1Rows - baseline.v1Rows;
    if (delta < 0
        || current.v2Rows !== baseline.v2Rows + delta
        || current.candidateRows !== baseline.candidateRows + delta
        || current.activeRows !== baseline.activeRows
        || current.archivedRows !== baseline.archivedRows
        || current.compatibilityRows !== baseline.compatibilityRows + delta
        || current.currentFtsRows !== baseline.currentFtsRows + delta
        || current.vectorRows !== baseline.vectorRows + delta
        || current.relationRows !== baseline.relationRows + delta
        || current.pendingOutboxRows !== baseline.pendingOutboxRows)
        return -1;
    return delta;
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
function validatePlan(value, expectedDigest) {
    const plan = value;
    if (plan?.schemaVersion !== 1
        || plan.phase !== "clawlore-candidate-durable-rewrite-proposal-plan"
        || plan.readOnly !== true
        || plan.queryOnly !== true
        || plan.containsProposedMemoryContent !== false
        || plan.containsOriginalMemoryContent !== false
        || plan.containsTranscriptContent !== false
        || plan.emitsRawIdentifiers !== false
        || plan.rewriteRepresentativeRows !== 3
        || plan.postRewriteDedupeHoldRows !== 3
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
        || plan.planDigest !== expectedDigest
        || plan.summary.targetGroups !== 3
        || plan.summary.targetRows !== 6
        || plan.summary.rewriteRepresentativeRows !== 3
        || plan.summary.postRewriteDedupeHoldRows !== 3
        || plan.summary.captureSafeProposals !== 3
        || plan.summary.corpusCollisionRows !== 0
        || plan.summary.mutationReadyRows !== 0
        || plan.rows.length !== 6
        || plan.groups.length !== 3)
        throw new Error("durable rewrite proposal plan is invalid or outside the exact three-row lane");
    const core = {
        proposedRewriteId: plan.proposedRewriteId,
        adjudicationPlanDigest: plan.adjudicationPlanDigest,
        adjudicationPreviewSha256: plan.adjudicationPreviewSha256,
        rewritePayloadDigest: plan.rewritePayloadDigest,
        rewritePayloadSha256: plan.rewritePayloadSha256,
        adjudicationSource: plan.adjudicationSource,
        appendOnlySourceExtensionRows: plan.appendOnlySourceExtensionRows,
        source: plan.source,
        summary: plan.summary,
        groups: plan.groups,
        rows: plan.rows,
    };
    if (hash(JSON.stringify(core)) !== plan.planDigest)
        throw new Error("durable rewrite proposal plan digest is invalid");
    return plan;
}
function validatePayload(value, sha256, plan) {
    const payload = value;
    if (payload?.schemaVersion !== 1
        || payload.phase !== "clawlore-durable-duplicate-rewrite-payload"
        || payload.readOnly !== true
        || payload.containsProposedMemoryContent !== true
        || payload.containsOriginalMemoryContent !== false
        || payload.containsTranscriptContent !== false
        || payload.containsRawIdentifiers !== false
        || payload.authorizesContentRewrite !== false
        || payload.authorizesSoftArchive !== false
        || payload.authorizesLifecycleMutation !== false
        || payload.authorizesVerificationMutation !== false
        || payload.payloadDigest !== plan.rewritePayloadDigest
        || sha256 !== plan.rewritePayloadSha256
        || payload.specifications.length !== 3)
        throw new Error("durable rewrite payload is invalid or unbound");
    const core = {
        adjudicationPlanDigest: payload.adjudicationPlanDigest,
        adjudicationPreviewSha256: payload.adjudicationPreviewSha256,
        specifications: payload.specifications,
    };
    if (payload.adjudicationPlanDigest !== plan.adjudicationPlanDigest
        || payload.adjudicationPreviewSha256 !== plan.adjudicationPreviewSha256
        || hash(JSON.stringify(core)) !== payload.payloadDigest)
        throw new Error("durable rewrite payload digest is invalid");
    return payload;
}
function validateAcceptance(value, plan, planSha256, payload, payloadSha256) {
    const acceptance = value;
    if (acceptance?.schemaVersion !== 1
        || acceptance.phase !== "clawlore-candidate-durable-rewrite-proposal-acceptance"
        || acceptance.status !== "pass"
        || acceptance.planDigest !== plan.planDigest
        || acceptance.planSha256 !== planSha256
        || acceptance.rewritePayloadDigest !== payload.payloadDigest
        || acceptance.rewritePayloadSha256 !== payloadSha256
        || JSON.stringify(acceptance.summary) !== JSON.stringify(plan.summary)
        || JSON.stringify(acceptance.live) !== JSON.stringify(plan.source)
        || acceptance.liveBindingMismatches !== 0
        || acceptance.proposedContentLeak !== false
        || acceptance.rawTraceOrIdentifierLeak !== false
        || acceptance.authorizesContentRewrite !== false
        || acceptance.authorizesSoftArchive !== false
        || acceptance.authorizesLifecycleMutation !== false
        || acceptance.requiresFreshEncryptedSnapshot !== true
        || acceptance.requiresSeparateExactApply !== true)
        throw new Error("durable rewrite proposal acceptance is invalid or unbound");
    return acceptance;
}
function validateBaseline(value, expectedDigest) {
    const baseline = value;
    const promotion = baseline?.candidatePromotionPlan;
    if (baseline?.schemaVersion !== 1
        || baseline.phase !== "clawlore-post-assignment-candidate-plan"
        || baseline.readOnly !== true
        || baseline.queryOnly !== true
        || baseline.emitsMemoryContent !== false
        || baseline.emitsTranscriptContent !== false
        || baseline.emitsRawIdentifiers !== false
        || baseline.authorizesLifecycleMutation !== false
        || baseline.authorizesContextEngine !== false
        || baseline.authorizesPromptMutation !== false
        || baseline.authorizesFinalRecall !== false
        || baseline.source.v1Rows !== baseline.source.v2Rows
        || baseline.source.unmirroredV1Rows !== 0
        || baseline.source.missingLegacyRowsForV2 !== 0
        || baseline.source.candidateBaselineUnchanged !== true
        || baseline.source.sourceUnchangedDuringPlan !== true
        || promotion?.schemaVersion !== 1
        || promotion.phase !== "clawlore-candidate-promotion-plan"
        || promotion.readOnly !== true
        || promotion.emitsItemIds !== false
        || promotion.automaticPromotionRows !== 0
        || promotion.authorizesLiveMutation !== false
        || promotion.planDigest !== expectedDigest
        || promotion.planDigest !== hash(JSON.stringify(promotion.rows))
        || promotion.rows.length !== baseline.source.candidateRows
        || baseline.decision.automaticPromotionRows !== 0)
        throw new Error("candidate baseline is invalid, unconverged, or digest-mismatched");
    return baseline;
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
    if (row.lifecycle !== "candidate"
        || row.verification !== "unverified"
        || hash(row.item_id) !== planned.itemIdSha256
        || hash(row.current_revision_id) !== planned.currentRevisionIdSha256
        || hash(row.content) !== planned.contentDigest
        || hash(normalizeCandidateContentV1(row.content)) !== planned.normalizedContentDigest
        || row.category !== planned.category
        || !validateSourceLineageReceiptV1(lineage, classification(metadata, evidence))
        || hash(JSON.stringify(lineage)) !== planned.sourceLineageReceiptDigest)
        throw new Error("durable rewrite live target no longer matches the accepted proposal");
}
function digestQuery(db, sql, args = []) {
    return hash(JSON.stringify(db.prepare(sql).all(...args)));
}
function nonTargetDigest(db, representativeItemIds) {
    const placeholders = representativeItemIds.map(() => "?").join(",");
    const parts = [
        digestQuery(db, `SELECT * FROM memory_items WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, representativeItemIds),
        digestQuery(db, `SELECT * FROM memory_revisions WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,revision_no`, representativeItemIds),
        digestQuery(db, `SELECT s.* FROM memory_sources s JOIN memory_revisions r ON r.revision_id=s.revision_id
      WHERE r.item_id NOT IN (${placeholders}) ORDER BY r.item_id,s.source_id`, representativeItemIds),
        digestQuery(db, `SELECT * FROM memory_acl WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,acl_id`, representativeItemIds),
        digestQuery(db, `SELECT * FROM memory_events WHERE item_id NOT IN (${placeholders}) ORDER BY item_id,event_id`, representativeItemIds),
        digestQuery(db, `SELECT rel.* FROM memory_relations rel
      JOIN memory_revisions source_revision ON source_revision.revision_id=rel.from_revision_id
      JOIN memory_revisions target_revision ON target_revision.revision_id=rel.to_revision_id
      WHERE source_revision.item_id NOT IN (${placeholders})
        AND target_revision.item_id NOT IN (${placeholders})
      ORDER BY rel.relation_id`, [...representativeItemIds, ...representativeItemIds]),
        digestQuery(db, `SELECT * FROM memory_fts_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, representativeItemIds),
        digestQuery(db, `SELECT * FROM memory_fts_compat_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, representativeItemIds),
        digestQuery(db, `SELECT * FROM memory_vector_projection_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, representativeItemIds),
        digestQuery(db, `SELECT * FROM memory_relation_projection_v2 WHERE item_id NOT IN (${placeholders}) ORDER BY item_id`, representativeItemIds),
        digestQuery(db, "SELECT * FROM projection_outbox ORDER BY outbox_id"),
    ];
    return hash(JSON.stringify(parts));
}
function protectedRepresentativeDigest(db, itemIds) {
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
export async function executeLiveCandidateDurableRewriteV1(input) {
    if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(input.rolloutId))
        throw new Error("durable rewrite rollout id is invalid");
    const appliedAtDate = input.now?.() ?? new Date();
    const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
    if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
        throw new Error("maximum snapshot age must be a positive integer");
    }
    const loadedPlan = privateJson(input.planPath);
    const plan = validatePlan(loadedPlan.value, input.planDigest);
    const loadedPayload = privateJson(input.payloadPath);
    const payload = validatePayload(loadedPayload.value, loadedPayload.sha256, plan);
    const loadedAcceptance = privateJson(input.proposalAcceptancePath);
    validateAcceptance(loadedAcceptance.value, plan, loadedPlan.sha256, payload, loadedPayload.sha256);
    const loadedBaseline = privateJson(input.candidateBaselinePath);
    const baseline = validateBaseline(loadedBaseline.value, input.candidateBaselineDigest);
    if (appendOnlyExtension(baseline.source, plan.source) < 0) {
        throw new Error("candidate baseline is not an isolated append-only extension of the rewrite proposal");
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
    if (!sameSource(beforeSource, baseline.source)) {
        db.close();
        throw new Error("live source no longer matches the converged candidate baseline");
    }
    const currentCandidates = candidateRows(db);
    if (currentCandidates.length !== beforeSource.candidateRows) {
        db.close();
        throw new Error("durable rewrite candidate mapping is incomplete");
    }
    const byHash = new Map(currentCandidates.map((row) => [hash(row.item_id), row]));
    for (const planned of plan.rows) {
        const live = byHash.get(planned.itemIdSha256);
        if (!live) {
            db.close();
            throw new Error("durable rewrite target mapping is incomplete");
        }
        try {
            assertTargetMatches(live, planned);
        }
        catch (error) {
            db.close();
            throw error;
        }
    }
    const representativePlans = plan.rows.filter((row) => row.role === "rewrite_representative");
    const companionPlans = plan.rows.filter((row) => row.role === "post_rewrite_dedupe_hold");
    if (representativePlans.length !== 3 || companionPlans.length !== 3) {
        db.close();
        throw new Error("durable rewrite role partition is invalid");
    }
    const specifications = new Map(payload.specifications.map((specification) => [specification.factKey, specification]));
    const representativeItemIds = representativePlans.map((planned) => byHash.get(planned.itemIdSha256).item_id).sort();
    const beforeNonTargetDigest = nonTargetDigest(db, representativeItemIds);
    const beforeProtectedDigest = protectedRepresentativeDigest(db, representativeItemIds);
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
        if (!sameSource(sourceState(db), beforeSource))
            throw new Error("live source drifted before durable rewrite transaction");
        const transactionCandidates = new Map(candidateRows(db).map((row) => [hash(row.item_id), row]));
        for (const planned of plan.rows) {
            const live = transactionCandidates.get(planned.itemIdSha256);
            if (!live)
                throw new Error("durable rewrite target disappeared before transaction");
            assertTargetMatches(live, planned);
        }
        for (const planned of representativePlans.sort((left, right) => left.itemIdSha256.localeCompare(right.itemIdSha256))) {
            const live = transactionCandidates.get(planned.itemIdSha256);
            const specification = specifications.get(planned.factKey);
            if (!specification
                || specification.representativeItemIdSha256 !== planned.itemIdSha256
                || specification.normalizedContentDigest !== planned.normalizedContentDigest
                || hash(specification.proposedContent) !== planned.proposedContentDigest
                || hash(normalizeCandidateContentV1(specification.proposedContent)) !== planned.proposedNormalizedContentDigest)
                throw new Error("durable rewrite specification no longer matches the representative plan");
            const revisionId = randomUUID();
            const oldEvidence = parseRecord(live.evidence_json);
            const evidence = {
                ...oldEvidence,
                durableRewriteReceiptV1: {
                    schemaVersion: 1,
                    rolloutId: input.rolloutId,
                    planDigest: plan.planDigest,
                    factKey: planned.factKey,
                    previousContentDigest: planned.contentDigest,
                    rewrittenContentDigest: planned.proposedContentDigest,
                    sourceLineageReceiptDigest: planned.sourceLineageReceiptDigest,
                    appliedAt,
                    preservesCurrentLifecycle: true,
                    preservesVerification: true,
                    preservesAddress: true,
                },
            };
            const superseded = db.prepare("UPDATE memory_revisions SET lifecycle='superseded' WHERE revision_id=? AND lifecycle='candidate'")
                .run(live.current_revision_id);
            if (Number(superseded.changes) !== 1)
                throw new Error("durable rewrite current revision supersession failed closed");
            db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(revisionId, live.item_id, Number(live.revision_no) + 1, specification.proposedContent, "candidate", "unverified", live.valid_until, appliedAt);
            db.prepare(`INSERT INTO memory_sources
        (source_id,revision_id,source_type,external_id,observed_at,evidence_json)
        VALUES (?,?,?,?,?,?)`).run(randomUUID(), revisionId, live.source_type, live.external_id, live.observed_at, JSON.stringify(evidence));
            db.prepare(`INSERT INTO memory_relations
        (relation_id,from_revision_id,to_revision_id,relation_type,created_at)
        VALUES (?,?,?,?,?)`).run(randomUUID(), revisionId, live.current_revision_id, "supersedes", appliedAt);
            db.prepare(`INSERT INTO memory_events
        (event_id,item_id,revision_id,event_type,actor,reason,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), live.item_id, revisionId, "corrected", "operator:bounded-durable-rewrite", input.rolloutId, appliedAt);
            const current = db.prepare(`UPDATE memory_items SET current_revision_id=?,revision_no=?,content=?,updated_at=?
        WHERE item_id=? AND lifecycle='candidate' AND verification='unverified'`).run(revisionId, Number(live.revision_no) + 1, specification.proposedContent, appliedAt, live.item_id);
            if (Number(current.changes) !== 1)
                throw new Error("durable rewrite current item update failed closed");
            const fts = db.prepare("UPDATE memory_fts_v2 SET content=?,category=? WHERE item_id=?")
                .run(specification.proposedContent, live.category, live.item_id);
            if (Number(fts.changes) !== 1)
                throw new Error("durable rewrite current FTS update failed closed");
        }
        db.prepare(`INSERT INTO clawlore_rollouts_v2
      (rollout_id,plan_digest,control_sha256,readiness_sha256,legacy_logical_digest,rows_applied,
       applied_at,v1_fallback_reads,context_engine_enabled,final_recall_cutover_enabled)
      VALUES (?,?,?,?,?,?,?,1,0,0)`).run(input.rolloutId, plan.planDigest, loadedPlan.sha256, snapshot.sha256, legacyBefore.memoryTruth.logicalDigest, 3, appliedAt);
        if (!sameSource(sourceState(db), beforeSource)
            || nonTargetDigest(db, representativeItemIds) !== beforeNonTargetDigest
            || protectedRepresentativeDigest(db, representativeItemIds) !== beforeProtectedDigest
            || scalar(db, "SELECT COUNT(*) FROM memory_revisions") !== beforeCounts.revisions + 3
            || scalar(db, "SELECT COUNT(*) FROM memory_sources") !== beforeCounts.sources + 3
            || scalar(db, "SELECT COUNT(*) FROM memory_relations") !== beforeCounts.relations + 3
            || scalar(db, "SELECT COUNT(*) FROM memory_events") !== beforeCounts.events + 3
            || scalar(db, "SELECT COUNT(*) FROM clawlore_rollouts_v2") !== beforeCounts.rollouts + 1)
            throw new Error("durable rewrite transaction exceeded the exact three-row boundary");
        const rewritten = representativeItemIds.map((itemId) => db.prepare(`SELECT i.item_id,i.lifecycle,i.verification,
      i.content,i.revision_no,r.lifecycle AS revision_lifecycle,r.verification AS revision_verification
      FROM memory_items i JOIN memory_revisions r ON r.revision_id=i.current_revision_id WHERE i.item_id=?`).get(itemId));
        if (rewritten.some((row) => row.lifecycle !== "candidate"
            || row.verification !== "unverified"
            || row.revision_lifecycle !== "candidate"
            || row.revision_verification !== "unverified"))
            throw new Error("durable rewrite changed the protected current lifecycle or verification state");
        const superseded = representativePlans.filter((planned) => {
            const live = transactionCandidates.get(planned.itemIdSha256);
            const row = db.prepare("SELECT lifecycle FROM memory_revisions WHERE revision_id=?").get(live.current_revision_id);
            return row?.lifecycle === "superseded";
        }).length;
        if (superseded !== 3)
            throw new Error("durable rewrite historical supersession bookkeeping is incomplete");
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (integrity !== "ok" || foreignKeyViolations !== 0)
            throw new Error("durable rewrite database integrity failed");
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
        throw new Error("durable rewrite post-commit acceptance failed");
    return {
        schemaVersion: 1,
        phase: "clawlore-candidate-durable-rewrite-live-apply",
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
        source: { ...afterSource, unchangedDuringApply: true },
        rewrite: {
            representativeRows: 3,
            companionRowsPreserved: 3,
            newRevisionRows: 3,
            oldRevisionRowsSuperseded: 3,
            newSourceRows: 3,
            newRelationRows: 3,
            newEventRows: 3,
            currentContentRowsChanged: 3,
            currentLifecycleRowsChanged: 0,
            currentVerificationRowsChanged: 0,
            addressRowsChanged: 0,
            aclRowsChanged: 0,
            companionRowsChanged: 0,
            nonTargetRowsChanged: 0,
        },
        projections: {
            currentFtsRowsChanged: 3,
            compatibilityRowsChanged: 0,
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
