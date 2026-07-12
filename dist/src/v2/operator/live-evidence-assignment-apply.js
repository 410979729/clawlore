import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
import { createLiveEvidenceAssignmentPlanV1, } from "./live-evidence-assignment-plan.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function privateBytes(path, maximumBytes = CONTROL_MAX_BYTES) {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > maximumBytes) {
        throw new Error("rollout control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    return { bytes, sha256: hash(bytes) };
}
function privateJson(path, maximumBytes = CONTROL_MAX_BYTES) {
    const loaded = privateBytes(path, maximumBytes);
    const value = JSON.parse(loaded.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("rollout control JSON is invalid");
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
        throw new Error("existing source evidence is not valid JSON");
    }
}
function stableStateDigest(row) {
    return hash(JSON.stringify({
        itemId: row.item_id,
        currentRevisionId: row.current_revision_id,
        addressJson: row.address_json,
        lifecycle: row.lifecycle,
        verification: row.verification,
    }));
}
function planCore(plan) {
    return {
        proposedRolloutId: plan.proposedRolloutId,
        remediationPlanDigest: plan.remediationPlanDigest,
        remediationPreviewSha256: plan.remediationPreviewSha256,
        sessionsRegistrySha256: plan.sessionsRegistrySha256,
        source: plan.source,
        summary: plan.summary,
        decisions: plan.decisions,
        rows: plan.rows,
    };
}
function loadPlan(path, rolloutId, digest) {
    const loaded = privateJson(path);
    const value = loaded.value;
    if (value.schemaVersion !== 1
        || value.phase !== "clawlore-evidence-assignment-plan"
        || value.proposedRolloutId !== rolloutId
        || value.planDigest !== digest
        || value.readOnly !== true
        || value.queryOnly !== true
        || value.emitsMemoryContent !== false
        || value.emitsTranscriptContent !== false
        || value.emitsRawIdentifiers !== false
        || value.automaticPromotionRows !== 0
        || value.authorizesEvidenceWrite !== false
        || value.authorizesLifecycleMutation !== false
        || value.authorizesContextEngine !== false
        || value.authorizesPromptMutation !== false
        || value.authorizesFinalRecall !== false
        || value.requiresFreshSnapshotBeforeApply !== true
        || value.requiresSeparateOperatorApproval !== true
        || hash(JSON.stringify(planCore(value))) !== value.planDigest)
        throw new Error("approved evidence-assignment plan is invalid or digest-mismatched");
    const targetRows = value.rows.filter((row) => row.decision.startsWith("propose_"));
    if (targetRows.length !== value.summary.proposedEvidenceAssignmentRows
        || targetRows.some((row) => !row.resolver || !row.resolverEvidenceDigest || !row.proposedEvidencePayloadDigest)
        || value.rows.some((row) => row.postLifecycle !== "candidate" || row.lifecycleMutationAllowed !== false))
        throw new Error("approved evidence-assignment target coverage is invalid");
    return loaded;
}
function loadApproval(path, rolloutId, planDigest) {
    const loaded = privateJson(path, 128 * 1024);
    const value = loaded.value;
    if (value.schemaVersion !== 1
        || value.phase !== "clawlore-evidence-assignment-approval"
        || value.rolloutId !== rolloutId
        || value.decision !== "approved"
        || !value.actor?.trim()
        || !Number.isFinite(Date.parse(value.approvedAt))
        || value.planDigest !== planDigest
        || value.allowFreshEncryptedSnapshot !== true
        || value.allowEvidenceWrite !== true
        || value.preserveLifecycle !== true
        || value.preserveVerification !== true
        || value.preserveV1Fallback !== true
        || value.allowManualPrincipalAssignment !== false
        || value.allowExternalSourceReceiptWrite !== false
        || value.allowQuarantineMutation !== false
        || value.allowContextEngine !== false
        || value.allowPromptMutation !== false
        || value.allowFinalRecallCutover !== false)
        throw new Error("operator approval is invalid or exceeds the authorized boundary");
    return loaded;
}
function loadFreshSnapshot(input) {
    const loaded = privateJson(input.receiptPath, 128 * 1024);
    const value = loaded.value;
    const createdAt = Date.parse(value.createdAt);
    const ageSeconds = Number.isFinite(createdAt)
        ? Math.max(0, Math.floor((input.now.getTime() - createdAt) / 1000))
        : Number.POSITIVE_INFINITY;
    const archive = privateBytes(input.archivePath, 1024 * 1024 * 1024);
    if (value.schemaVersion !== 1
        || value.phase !== "clawlore-v2-live-encrypted-snapshot"
        || value.status !== "pass"
        || value.authorizesV2Writes !== false
        || value.sourceStableDuringBackup !== true
        || value.restoreVerified !== true
        || value.restoredPlaintextRemoved !== true
        || value.snapshot?.integrity !== "ok"
        || value.snapshot?.foreignKeyViolations !== 0
        || ageSeconds > input.maximumAgeSeconds
        || archive.sha256 !== value.archiveSha256)
        throw new Error("fresh encrypted snapshot is invalid, stale, or checksum-mismatched");
    return loaded;
}
function assertTargetScopedPlanMatch(approved, current) {
    const stableFields = [
        "remediationPlanDigest",
        "remediationPreviewSha256",
        "source",
        "summary",
        "decisions",
        "rows",
    ];
    if (stableFields.some((field) => JSON.stringify(approved[field]) !== JSON.stringify(current[field]))) {
        throw new Error("live target evidence no longer matches the approved exact plan");
    }
}
function scalar(db, sql) {
    const row = db.prepare(sql).get();
    return Number(Object.values(row)[0] ?? 0);
}
function lifecycleCounts(db) {
    const rows = db.prepare("SELECT lifecycle,COUNT(*) AS rows FROM memory_items GROUP BY lifecycle ORDER BY lifecycle")
        .all();
    return Object.fromEntries(rows.map((row) => [row.lifecycle, Number(row.rows)]));
}
function canonicalDigest(db) {
    const rows = db.prepare(`SELECT item_id,current_revision_id,address_json,lifecycle,verification
    FROM memory_items ORDER BY item_id`).all();
    return hash(JSON.stringify(rows));
}
function sourceEvidenceRows(db) {
    return db.prepare("SELECT source_id,evidence_json FROM memory_sources ORDER BY source_id").all();
}
function evidenceDigest(rows, exclude) {
    return hash(JSON.stringify(rows.filter((row) => !exclude.has(row.source_id))));
}
export async function executeLiveEvidenceAssignmentV1(input) {
    const appliedAtDate = input.now?.() ?? new Date();
    const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
    if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
        throw new Error("maximum snapshot age must be a positive integer");
    }
    const plan = loadPlan(input.planPath, input.rolloutId, input.planDigest);
    const approval = loadApproval(input.approvalPath, input.rolloutId, input.planDigest);
    const snapshot = loadFreshSnapshot({
        receiptPath: input.snapshotReceiptPath,
        archivePath: input.snapshotArchivePath,
        now: appliedAtDate,
        maximumAgeSeconds,
    });
    const currentPlan = createLiveEvidenceAssignmentPlanV1({
        sourcePath: input.sourcePath,
        sessionsRegistryPath: input.sessionsRegistryPath,
        remediationPreviewPath: input.remediationPreviewPath,
        baselinePromotionPreviewPath: input.baselinePromotionPreviewPath,
        proposedRolloutId: input.rolloutId,
    });
    assertTargetScopedPlanMatch(plan.value, currentPlan);
    const legacyBefore = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (legacyBefore.schemaDigest !== snapshot.value.snapshot.schemaDigest
        || legacyBefore.memoryTruth.rowCount !== snapshot.value.snapshot.memoryTruthRows
        || legacyBefore.memoryTruth.logicalDigest !== snapshot.value.snapshot.memoryTruthLogicalDigest)
        throw new Error("live truth no longer matches the fresh encrypted snapshot");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
    const targets = plan.value.rows.filter((row) => row.decision.startsWith("propose_"));
    const targetByItemHash = new Map(targets.map((row) => [row.itemIdSha256, row]));
    const beforeCanonicalDigest = canonicalDigest(db);
    const beforeItems = scalar(db, "SELECT COUNT(*) FROM memory_items");
    const beforeLifecycle = lifecycleCounts(db);
    const beforePendingOutbox = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL");
    const beforeCompatibility = scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2");
    const beforeSources = sourceEvidenceRows(db);
    const expectedEvidence = new Map();
    const targetSourceIds = new Set();
    let directPrincipalRows = 0;
    let conversationBoundaryRows = 0;
    try {
        db.exec("BEGIN IMMEDIATE");
        const liveStates = db.prepare(`SELECT item_id,current_revision_id,address_json,lifecycle,verification
      FROM memory_items WHERE lifecycle='candidate' ORDER BY item_id`).all();
        const approvedRows = new Map(plan.value.rows.map((row) => [row.itemIdSha256, row]));
        if (liveStates.length !== plan.value.source.candidateRows
            || liveStates.some((state) => {
                const row = approvedRows.get(hash(state.item_id));
                return !row || row.currentStateDigest !== stableStateDigest(state);
            }))
            throw new Error("candidate state changed after exact-plan validation");
        const sourceRows = db.prepare(`SELECT i.item_id,i.current_revision_id,i.address_json,i.lifecycle,i.verification,
      s.source_id,s.evidence_json FROM memory_items i JOIN memory_sources s
      ON s.revision_id=i.current_revision_id WHERE i.lifecycle='candidate' ORDER BY i.item_id,s.source_id`)
            .all();
        const sourcesByItem = new Map();
        for (const row of sourceRows) {
            const rows = sourcesByItem.get(row.item_id) ?? [];
            rows.push(row);
            sourcesByItem.set(row.item_id, rows);
        }
        if (sourcesByItem.size !== liveStates.length)
            throw new Error("candidate source coverage is incomplete");
        const update = db.prepare("UPDATE memory_sources SET evidence_json=? WHERE source_id=?");
        for (const state of liveStates) {
            const target = targetByItemHash.get(hash(state.item_id));
            if (!target)
                continue;
            const sources = sourcesByItem.get(state.item_id) ?? [];
            if (sources.length !== 1)
                throw new Error("target candidate must have exactly one current source row");
            const source = sources[0];
            const existing = parseRecord(source.evidence_json);
            if ("registryResolvedEvidenceV1" in existing)
                throw new Error("target evidence assignment already exists");
            const decision = target.decision;
            const evidenceKind = decision === "propose_private_principal_evidence_assignment"
                ? "direct-principal"
                : "conversation-boundary";
            if (evidenceKind === "direct-principal")
                directPrincipalRows += 1;
            else
                conversationBoundaryRows += 1;
            const assignment = {
                schemaVersion: 1,
                rolloutId: input.rolloutId,
                planDigest: input.planDigest,
                evidenceKind,
                resolver: target.resolver,
                resolverEvidenceDigest: target.resolverEvidenceDigest,
                currentStateDigest: target.currentStateDigest,
                proposedEvidencePayloadDigest: target.proposedEvidencePayloadDigest,
                assignedAt: appliedAtDate.toISOString(),
                preservesLifecycle: true,
                preservesVerification: true,
            };
            const updated = JSON.stringify({ ...existing, registryResolvedEvidenceV1: assignment });
            const result = update.run(updated, source.source_id);
            if (Number(result.changes) !== 1)
                throw new Error("evidence assignment did not update exactly one source row");
            targetSourceIds.add(source.source_id);
            expectedEvidence.set(source.source_id, updated);
        }
        if (expectedEvidence.size !== targets.length
            || directPrincipalRows !== plan.value.decisions.propose_private_principal_evidence_assignment
            || conversationBoundaryRows !== plan.value.decisions.propose_conversation_boundary_evidence_assignment)
            throw new Error("applied evidence assignment counts do not match the exact plan");
        const afterSourcesInTransaction = sourceEvidenceRows(db);
        const afterBySource = new Map(afterSourcesInTransaction.map((row) => [row.source_id, row.evidence_json]));
        if (afterSourcesInTransaction.length !== beforeSources.length
            || [...expectedEvidence].some(([sourceId, value]) => afterBySource.get(sourceId) !== value)
            || evidenceDigest(beforeSources, targetSourceIds) !== evidenceDigest(afterSourcesInTransaction, targetSourceIds)
            || canonicalDigest(db) !== beforeCanonicalDigest
            || scalar(db, "SELECT COUNT(*) FROM memory_items") !== beforeItems
            || JSON.stringify(lifecycleCounts(db)) !== JSON.stringify(beforeLifecycle)
            || scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL") !== beforePendingOutbox
            || scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2") !== beforeCompatibility)
            throw new Error("transaction exceeded the approved evidence-only boundary");
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (integrity !== "ok" || foreignKeyViolations !== 0)
            throw new Error("database verification failed before commit");
        db.exec("COMMIT");
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* preserve original error */ }
        db.close();
        throw error;
    }
    const afterSources = sourceEvidenceRows(db);
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    const canonicalUnchanged = canonicalDigest(db) === beforeCanonicalDigest;
    const itemsUnchanged = scalar(db, "SELECT COUNT(*) FROM memory_items") === beforeItems;
    const lifecycleUnchanged = JSON.stringify(lifecycleCounts(db)) === JSON.stringify(beforeLifecycle);
    const pendingOutboxUnchanged = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL") === beforePendingOutbox;
    const compatibilityUnchanged = scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2") === beforeCompatibility;
    const nonTargetEvidenceUnchanged = evidenceDigest(beforeSources, targetSourceIds)
        === evidenceDigest(afterSources, targetSourceIds);
    db.close();
    const legacyAfter = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (integrity !== "ok"
        || foreignKeyViolations !== 0
        || !canonicalUnchanged
        || !itemsUnchanged
        || !lifecycleUnchanged
        || !pendingOutboxUnchanged
        || !compatibilityUnchanged
        || !nonTargetEvidenceUnchanged
        || legacyAfter.memoryTruth.rowCount !== legacyBefore.memoryTruth.rowCount
        || legacyAfter.memoryTruth.logicalDigest !== legacyBefore.memoryTruth.logicalDigest)
        throw new Error("post-commit evidence-assignment verification failed");
    return {
        schemaVersion: 1,
        phase: "clawlore-v2-live-evidence-assignment",
        rolloutId: input.rolloutId,
        status: "applied",
        appliedAt: appliedAtDate.toISOString(),
        planDigest: input.planDigest,
        approvalSha256: approval.sha256,
        planSha256: plan.sha256,
        snapshotReceiptSha256: snapshot.sha256,
        snapshotArchiveSha256: snapshot.value.archiveSha256,
        source: {
            memoryTruthRows: legacyAfter.memoryTruth.rowCount,
            memoryTruthLogicalDigest: legacyAfter.memoryTruth.logicalDigest,
            unchanged: true,
        },
        evidence: {
            rowsWritten: targets.length,
            directPrincipalRows,
            conversationBoundaryRows,
            manualRowsChanged: 0,
            externalSourceReceiptRowsChanged: 0,
            quarantineRowsChanged: 0,
            nonTargetEvidenceRowsChanged: 0,
        },
        canonical: {
            memoryItemRowsChanged: 0,
            lifecycleRowsChanged: 0,
            verificationRowsChanged: 0,
            addressRowsChanged: 0,
            pendingOutboxRowsChanged: 0,
            compatibilityRowsChanged: 0,
        },
        database: { integrity: "ok", foreignKeyViolations: 0 },
        runtime: {
            v1FallbackReads: true,
            lifecycleMutationEnabled: false,
            contextEngineEnabled: false,
            promptMutationEnabled: false,
            finalRecallCutoverEnabled: false,
        },
    };
}
