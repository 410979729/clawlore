import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { preparePrivateFileForRead } from "../../file-privacy.js";
import { resolvePrincipalWriteTarget } from "../../principal-write-boundary.js";
import { resolveRuntimeMemoryBoundary } from "../../runtime-memory-boundary.js";
import { syncLifecycleProjectionFromTruth } from "../../sql-lifecycle-projection.js";
import { validateMemoryAddress } from "../domain/memory-address.js";
import { classifyLegacyPrincipalAttributionV1 } from "../migration/legacy-principal-attribution.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
import { computeLegacyPrincipalTruthStateDigestV1, computeLivePrincipalScopePlanDigestV1, computePrincipalV2StateDigestV1, createLivePrincipalScopePlanV1, } from "./live-principal-scope-plan.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 10 * 1024 * 1024;
const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 60 * 60;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function privateBytes(path, maximumBytes) {
    if (process.platform === "win32")
        preparePrivateFileForRead(path);
    const info = statSync(path);
    if (!info.isFile()
        || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
        || info.size <= 0
        || info.size > maximumBytes)
        throw new Error("principal-scope control must be a non-empty owner-only file");
    const bytes = readFileSync(path);
    return { bytes, sha256: hash(bytes) };
}
function privateJson(path, maximumBytes = CONTROL_MAX_BYTES) {
    const loaded = privateBytes(path, maximumBytes);
    const value = JSON.parse(loaded.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("principal-scope control JSON is invalid");
    }
    return { value, sha256: loaded.sha256 };
}
function loadPlan(input) {
    const loaded = privateJson(input.path);
    const plan = loaded.value;
    if (plan.schemaVersion !== 1
        || plan.phase !== "clawlore-live-principal-scope-plan"
        || plan.proposedMigrationId !== input.migrationId
        || plan.planDigest !== input.planDigest
        || computeLivePrincipalScopePlanDigestV1(plan) !== plan.planDigest
        || plan.readOnly !== true
        || plan.queryOnly !== true
        || plan.emitsMemoryContent !== false
        || plan.emitsTranscriptContent !== false
        || plan.emitsRawIdentifiers !== false
        || plan.decision.assignmentReady !== true
        || plan.decision.requiresFreshEncryptedSnapshot !== true
        || plan.decision.automaticLifecyclePromotionRows !== 0
        || plan.decision.finalRecallCutoverReady !== false
        || plan.authorizesScopeMutation !== false
        || plan.authorizesLifecycleMutation !== false
        || plan.authorizesContextEngine !== false
        || plan.authorizesPromptMutation !== false
        || plan.authorizesFinalRecall !== false
        || plan.summary.principalAssignmentRows <= 0
        || plan.summary.migrationEligibleRows <= 0
        || plan.summary.unmirroredAssignmentRows !== 0)
        throw new Error("principal-scope plan is invalid, blocked, or digest-mismatched");
    return loaded;
}
function loadFreshSnapshot(input) {
    const receipt = privateJson(input.receiptPath, 256 * 1024);
    const archive = privateBytes(input.archivePath, ARCHIVE_MAX_BYTES);
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
        || receipt.value.snapshot?.integrity !== "ok"
        || receipt.value.snapshot?.foreignKeyViolations !== 0
        || receipt.value.snapshot.schemaDigest !== input.plan.source.schemaDigest
        || receipt.value.snapshot.memoryTruthRows !== input.plan.source.memoryTruthRows
        || receipt.value.snapshot.memoryTruthLogicalDigest !== input.plan.source.memoryTruthLogicalDigest
        || receipt.value.archiveSha256 !== archive.sha256
        || ageSeconds > input.maximumAgeSeconds)
        throw new Error("principal-scope encrypted snapshot is invalid, stale, or source-mismatched");
    return { value: receipt.value, sha256: receipt.sha256, archiveSha256: archive.sha256 };
}
function parseRecord(value) {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("principal-scope JSON state is invalid");
    }
    return parsed;
}
function scalar(db, sql, ...params) {
    const row = db.prepare(sql).get(...params);
    return Number(Object.values(row)[0] ?? 0);
}
function currentContentLifecycleDigest(db) {
    const rows = db.prepare(`SELECT item_id,current_revision_id,content,category,lifecycle,verification,
    valid_until,created_at FROM memory_items ORDER BY item_id`).all();
    return hash(JSON.stringify(rows));
}
function createMigrationSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS clawlore_principal_scope_migrations (
      migration_id TEXT PRIMARY KEY,
      plan_digest TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL,
      snapshot_receipt_sha256 TEXT NOT NULL,
      snapshot_archive_sha256 TEXT NOT NULL,
      source_logical_digest TEXT NOT NULL,
      source_scope_sha256 TEXT NOT NULL,
      session_key_sha256 TEXT NOT NULL,
      target_scope TEXT NOT NULL,
      principal_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('truth_applied_vector_pending','complete','rolled_back')),
      rows_applied INTEGER NOT NULL,
      v1_scope_rows_changed INTEGER NOT NULL,
      vector_repair_rows INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS clawlore_principal_scope_migration_items (
      migration_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      original_scope TEXT NOT NULL,
      target_scope TEXT NOT NULL,
      original_address_json TEXT NOT NULL,
      original_acl_json TEXT NOT NULL,
      original_source_json TEXT NOT NULL,
      truth_state_digest TEXT NOT NULL,
      v2_state_digest TEXT NOT NULL,
      PRIMARY KEY(migration_id,memory_id),
      FOREIGN KEY(migration_id) REFERENCES clawlore_principal_scope_migrations(migration_id)
        DEFERRABLE INITIALLY DEFERRED
    );
  `);
}
function receiptFromStored(input) {
    const status = String(input.row.status);
    if (status !== "truth_applied_vector_pending" && status !== "complete") {
        throw new Error("principal-scope migration is not in a replayable state");
    }
    const rows = Number(input.row.rows_applied);
    const scopeRows = Number(input.row.v1_scope_rows_changed);
    const vectorRepairRows = Number(input.row.vector_repair_rows);
    return {
        schemaVersion: 1,
        phase: "clawlore-live-principal-scope-apply",
        migrationId: String(input.row.migration_id),
        status,
        idempotentReplay: input.idempotentReplay,
        appliedAt: String(input.row.applied_at),
        ...(input.row.completed_at ? { completedAt: String(input.row.completed_at) } : {}),
        planDigest: String(input.row.plan_digest),
        planSha256: String(input.row.plan_sha256),
        snapshotReceiptSha256: String(input.row.snapshot_receipt_sha256),
        snapshotArchiveSha256: String(input.row.snapshot_archive_sha256),
        source: {
            memoryTruthRows: input.plan.source.memoryTruthRows,
            preMigrationLogicalDigest: String(input.row.source_logical_digest),
            sourceScopeSha256: String(input.row.source_scope_sha256),
            sessionKeySha256: String(input.row.session_key_sha256),
        },
        target: {
            contract: "openclaw-scope-v1",
            scope: String(input.row.target_scope),
            principalHash: String(input.row.principal_hash),
        },
        mutation: {
            v1ScopeRowsChanged: scopeRows,
            lifecycleProjectionRowsChanged: scopeRows,
            v2AddressRowsChanged: rows,
            aclRowsChanged: rows,
            sourceEvidenceRowsChanged: rows,
            auditEventsWritten: rows,
            vectorRepairRowsPending: status === "complete" ? 0 : vectorRepairRows,
            lifecycleRowsChanged: 0,
            verificationRowsChanged: 0,
            contentRowsChanged: 0,
        },
        database: { integrity: "ok", foreignKeyViolations: 0 },
        runtime: {
            contextEngineEnabled: false,
            promptMutationEnabled: false,
            finalRecallCutoverEnabled: false,
        },
    };
}
export async function executeLivePrincipalScopeApplyV1(input) {
    const appliedAtDate = input.now?.() ?? new Date();
    const maximumAgeSeconds = input.maximumSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
    if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds <= 0) {
        throw new Error("maximum snapshot age must be a positive integer");
    }
    const plan = loadPlan({ path: input.planPath, migrationId: input.migrationId, planDigest: input.planDigest });
    const target = resolvePrincipalWriteTarget({ sessionKey: input.targetSessionKey });
    const boundary = resolveRuntimeMemoryBoundary({ runtimeContext: { sessionKey: input.targetSessionKey } });
    if (target.kind !== "private"
        || !target.principalHash
        || boundary.kind !== "private"
        || !boundary.principalKey
        || !boundary.platform
        || !boundary.accountId)
        throw new Error("principal-scope apply target is not one exact private principal");
    if (plan.value.target.scope !== target.scope
        || plan.value.target.principalHash !== target.principalHash
        || plan.value.target.sessionKeySha256 !== hash(input.targetSessionKey)
        || plan.value.target.sourceScopeSha256 !== hash(input.sourceScope))
        throw new Error("principal-scope target no longer matches the plan");
    const { DatabaseSync } = require("node:sqlite");
    const replayDb = new DatabaseSync(input.sourcePath, { readOnly: true });
    try {
        const hasReceiptTable = Boolean(replayDb.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='clawlore_principal_scope_migrations'`).get());
        const stored = hasReceiptTable
            ? replayDb.prepare("SELECT * FROM clawlore_principal_scope_migrations WHERE migration_id=?")
                .get(input.migrationId)
            : undefined;
        if (stored) {
            if (stored.plan_digest !== input.planDigest
                || stored.target_scope !== target.scope
                || stored.principal_hash !== target.principalHash
                || stored.source_scope_sha256 !== hash(input.sourceScope)
                || stored.session_key_sha256 !== hash(input.targetSessionKey)
                || scalar(replayDb, `SELECT COUNT(*) FROM clawlore_principal_scope_migration_items
          WHERE migration_id=?`, input.migrationId) !== Number(stored.rows_applied)
                || scalar(replayDb, `SELECT COUNT(*) FROM memory_truth t
          JOIN clawlore_principal_scope_migration_items m ON m.memory_id=t.id
          WHERE m.migration_id=? AND t.scope=?`, input.migrationId, target.scope) !== Number(stored.rows_applied)
                || scalar(replayDb, `SELECT COUNT(*) FROM clawlore_principal_scope_migration_items
          WHERE migration_id=? AND original_scope<>target_scope`, input.migrationId)
                    !== Number(stored.v1_scope_rows_changed))
                throw new Error("principal-scope stored migration receipt failed replay validation");
            const integrity = String(Object.values(replayDb.prepare("PRAGMA integrity_check").get())[0]);
            const foreignKeyViolations = replayDb.prepare("PRAGMA foreign_key_check").all().length;
            if (integrity !== "ok" || foreignKeyViolations !== 0) {
                throw new Error("principal-scope stored migration database verification failed");
            }
            return receiptFromStored({ row: stored, plan: plan.value, idempotentReplay: true });
        }
    }
    finally {
        replayDb.close();
    }
    const snapshot = loadFreshSnapshot({
        receiptPath: input.snapshotReceiptPath,
        archivePath: input.snapshotArchivePath,
        now: appliedAtDate,
        maximumAgeSeconds,
        plan: plan.value,
    });
    const currentPlan = await createLivePrincipalScopePlanV1({
        sourcePath: input.sourcePath,
        targetSessionKey: input.targetSessionKey,
        sourceScope: input.sourceScope,
        proposedMigrationId: input.migrationId,
        now: () => appliedAtDate,
    });
    if (currentPlan.planDigest !== plan.value.planDigest) {
        throw new Error("principal-scope live source no longer matches the exact plan");
    }
    const currentSnapshot = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (currentSnapshot.schemaDigest !== snapshot.value.snapshot.schemaDigest
        || currentSnapshot.memoryTruth.rowCount !== snapshot.value.snapshot.memoryTruthRows
        || currentSnapshot.memoryTruth.logicalDigest !== snapshot.value.snapshot.memoryTruthLogicalDigest)
        throw new Error("principal-scope live truth no longer matches the encrypted snapshot");
    const db = new DatabaseSync(input.sourcePath);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
    const id = input.id ?? randomUUID;
    const appliedAt = appliedAtDate.toISOString();
    const appliedAtMs = appliedAtDate.getTime();
    try {
        db.exec("BEGIN IMMEDIATE");
        createMigrationSchema(db);
        const existingStored = db.prepare("SELECT * FROM clawlore_principal_scope_migrations WHERE migration_id=?")
            .get(input.migrationId);
        if (existingStored) {
            if (existingStored.plan_digest !== input.planDigest
                || existingStored.target_scope !== target.scope
                || existingStored.principal_hash !== target.principalHash)
                throw new Error("principal-scope migration id is already bound to different controls");
            db.exec("COMMIT");
            db.close();
            return receiptFromStored({ row: existingStored, plan: plan.value, idempotentReplay: true });
        }
        const beforeTruthRows = scalar(db, "SELECT COUNT(*) FROM memory_truth");
        const beforeV2Rows = scalar(db, "SELECT COUNT(*) FROM memory_items");
        const beforeFtsRows = scalar(db, "SELECT COUNT(*) FROM memory_truth_fts");
        const beforeLifecycleRows = scalar(db, "SELECT COUNT(*) FROM memory_lifecycle_projection");
        const beforeContentLifecycle = currentContentLifecycleDigest(db);
        const plannedRows = new Map(plan.value.rows.filter((row) => row.principalAssignmentEligible)
            .map((row) => [row.legacyIdSha256, row]));
        const truthRows = db.prepare(`SELECT id,text,category,scope,importance,timestamp,metadata,
      metadata_text,updated_at FROM memory_truth ORDER BY id`).all();
        const targets = [];
        for (const truth of truthRows) {
            const attribution = classifyLegacyPrincipalAttributionV1({
                metadata: truth.metadata,
                currentScope: truth.scope,
                sourceScope: input.sourceScope,
                targetScope: target.scope,
                targetSessionKey: input.targetSessionKey,
            });
            const principalAssignmentEligible = attribution.migrationEligible
                || attribution.lane === "target_private_already_assigned";
            if (!principalAssignmentEligible)
                continue;
            const planned = plannedRows.get(hash(truth.id));
            if (!planned
                || planned.principalAssignmentEligible !== true
                || planned.migrationEligible !== attribution.migrationEligible
                || planned.currentStateDigest !== computeLegacyPrincipalTruthStateDigestV1(truth)) {
                throw new Error("principal-scope truth row drifted after plan validation");
            }
            targets.push({ truth, planned });
        }
        if (targets.length !== plan.value.summary.principalAssignmentRows) {
            throw new Error("principal-scope target coverage no longer matches the plan");
        }
        db.prepare(`INSERT INTO clawlore_principal_scope_migrations
      (migration_id,plan_digest,plan_sha256,snapshot_receipt_sha256,snapshot_archive_sha256,
       source_logical_digest,source_scope_sha256,session_key_sha256,target_scope,principal_hash,
       status,rows_applied,v1_scope_rows_changed,vector_repair_rows,applied_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,NULL)`).run(input.migrationId, input.planDigest, plan.sha256, snapshot.sha256, snapshot.archiveSha256, plan.value.source.memoryTruthLogicalDigest, hash(input.sourceScope), hash(input.targetSessionKey), target.scope, target.principalHash, "truth_applied_vector_pending", appliedAt);
        const v2Statement = db.prepare(`SELECT item_id,current_revision_id,address_json,principal_id,
      visibility,lifecycle,verification FROM memory_items WHERE item_id=?`);
        const aclStatement = db.prepare(`SELECT acl_id,owner_principal_id,visibility,policy_json,created_at
      FROM memory_acl WHERE item_id=? ORDER BY acl_id`);
        const sourceStatement = db.prepare(`SELECT source_id,evidence_json FROM memory_sources
      WHERE revision_id=? ORDER BY source_id`);
        let applied = 0;
        let scopeRowsChanged = 0;
        let vectorRepairRows = 0;
        for (const { truth, planned } of targets) {
            const itemId = `legacy:${truth.id}`;
            const v2 = v2Statement.get(itemId);
            if (!v2)
                throw new Error("principal-scope target lost its V2 mirror");
            const acl = aclStatement.all(itemId);
            const sources = sourceStatement.all(v2.current_revision_id);
            const v2Digest = computePrincipalV2StateDigestV1({
                v2: v2,
                acl,
                sources: sources,
            });
            if (!planned.v2Mirrored
                || planned.v2StateDigest !== v2Digest
                || acl.length !== 1
                || sources.length !== 1)
                throw new Error("principal-scope V2/ACL/source state drifted after plan validation");
            const address = parseRecord(v2.address_json);
            if (v2.principal_id !== "legacy:unresolved" && v2.principal_id !== boundary.principalKey) {
                throw new Error("principal-scope target has a conflicting V2 principal");
            }
            if (address.conversationId || address.threadId || address.projectId) {
                throw new Error("principal-scope private target carries a conflicting shared boundary");
            }
            const nextAddress = {
                ...address,
                principalId: boundary.principalKey,
                platform: boundary.platform,
                accountId: boundary.accountId,
                visibility: "private",
            };
            const validation = validateMemoryAddress(nextAddress);
            if (!validation.valid)
                throw new Error("principal-scope target address is invalid");
            db.prepare(`INSERT INTO clawlore_principal_scope_migration_items
        (migration_id,memory_id,item_id,original_scope,target_scope,original_address_json,
         original_acl_json,original_source_json,truth_state_digest,v2_state_digest)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.migrationId, truth.id, itemId, truth.scope, target.scope, v2.address_json, JSON.stringify(acl), JSON.stringify(sources), planned.currentStateDigest, v2Digest);
            if (planned.migrationEligible) {
                const truthUpdate = db.prepare(`UPDATE memory_truth SET scope=?,updated_at=?
          WHERE id=? AND scope=?`).run(target.scope, appliedAtMs, truth.id, input.sourceScope);
                if (Number(truthUpdate.changes) !== 1) {
                    throw new Error("principal-scope V1 update missed its exact source row");
                }
                syncLifecycleProjectionFromTruth(db, truth.id);
                db.prepare(`INSERT INTO vector_companion_repair_outbox
          (memory_id,action,operation,last_error,attempts,created_at,updated_at)
          VALUES (?,'upsert','principal-scope-assignment','pending_vector_companion_sync',1,?,?)
          ON CONFLICT(memory_id) DO UPDATE SET action='upsert',operation=excluded.operation,
            last_error=excluded.last_error,attempts=vector_companion_repair_outbox.attempts+1,
            updated_at=excluded.updated_at`).run(truth.id, appliedAtMs, appliedAtMs);
                scopeRowsChanged += 1;
                vectorRepairRows += 1;
            }
            else if (truth.scope !== target.scope) {
                throw new Error("principal-scope V2-only assignment is not already in the target V1 scope");
            }
            const itemUpdate = db.prepare(`UPDATE memory_items SET address_json=?,principal_id=?,
        visibility='private',updated_at=? WHERE item_id=? AND current_revision_id=?`).run(JSON.stringify(nextAddress), boundary.principalKey, appliedAt, itemId, v2.current_revision_id);
            if (Number(itemUpdate.changes) !== 1)
                throw new Error("principal-scope V2 address update was not exact");
            const aclUpdate = db.prepare(`UPDATE memory_acl SET owner_principal_id=?,visibility='private'
        WHERE item_id=?`).run(boundary.principalKey, itemId);
            if (Number(aclUpdate.changes) !== 1)
                throw new Error("principal-scope ACL update was not exact");
            const source = sources[0];
            const evidence = parseRecord(source.evidence_json);
            if ("principalScopeAssignmentV1" in evidence) {
                throw new Error("principal-scope source already carries a different assignment receipt");
            }
            const assignment = {
                schemaVersion: 1,
                migrationId: input.migrationId,
                planDigest: input.planDigest,
                contract: target.contract,
                targetScope: target.scope,
                principalHash: target.principalHash,
                sessionKeySha256: hash(input.targetSessionKey),
                referenceDigest: planned.referenceDigest,
                assignedAt: appliedAt,
                preservesContent: true,
                preservesLifecycle: true,
                preservesVerification: true,
            };
            const sourceUpdate = db.prepare("UPDATE memory_sources SET evidence_json=? WHERE source_id=?")
                .run(JSON.stringify({ ...evidence, principalScopeAssignmentV1: assignment }), source.source_id);
            if (Number(sourceUpdate.changes) !== 1)
                throw new Error("principal-scope source evidence update was not exact");
            db.prepare(`INSERT INTO memory_events
        (event_id,item_id,revision_id,event_type,actor,reason,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(id(), itemId, v2.current_revision_id, "principal_scope_assigned", "operator:principal-scope-migration", "exact_private_session_provenance", appliedAt);
            applied += 1;
        }
        db.prepare(`UPDATE clawlore_principal_scope_migrations
      SET rows_applied=?,v1_scope_rows_changed=?,vector_repair_rows=?
      WHERE migration_id=?`).run(applied, scopeRowsChanged, vectorRepairRows, input.migrationId);
        if (applied !== plan.value.summary.principalAssignmentRows
            || scopeRowsChanged !== plan.value.summary.migrationEligibleRows
            || vectorRepairRows !== plan.value.summary.migrationEligibleRows
            || scalar(db, "SELECT COUNT(*) FROM memory_truth") !== beforeTruthRows
            || scalar(db, "SELECT COUNT(*) FROM memory_items") !== beforeV2Rows
            || scalar(db, "SELECT COUNT(*) FROM memory_truth_fts") !== beforeFtsRows
            || scalar(db, "SELECT COUNT(*) FROM memory_lifecycle_projection") !== beforeLifecycleRows
            || currentContentLifecycleDigest(db) !== beforeContentLifecycle
            || scalar(db, `SELECT COUNT(*) FROM clawlore_principal_scope_migration_items
        WHERE migration_id=?`, input.migrationId) !== applied
            || scalar(db, `SELECT COUNT(*) FROM memory_truth t JOIN clawlore_principal_scope_migration_items m
        ON m.memory_id=t.id WHERE m.migration_id=? AND t.scope=?`, input.migrationId, target.scope) !== applied
            || scalar(db, `SELECT COUNT(*) FROM memory_lifecycle_projection p
        JOIN clawlore_principal_scope_migration_items m ON m.memory_id=p.memory_id
        WHERE m.migration_id=? AND p.scope=?`, input.migrationId, target.scope) !== applied
            || scalar(db, `SELECT COUNT(*) FROM memory_items i
        JOIN clawlore_principal_scope_migration_items m ON m.item_id=i.item_id
        WHERE m.migration_id=? AND i.principal_id=? AND i.visibility='private'`, input.migrationId, boundary.principalKey) !== applied
            || scalar(db, `SELECT COUNT(*) FROM memory_acl a
        JOIN clawlore_principal_scope_migration_items m ON m.item_id=a.item_id
        WHERE m.migration_id=? AND a.owner_principal_id=? AND a.visibility='private'`, input.migrationId, boundary.principalKey) !== applied
            || scalar(db, `SELECT COUNT(*) FROM vector_companion_repair_outbox o
        JOIN clawlore_principal_scope_migration_items m ON m.memory_id=o.memory_id
        WHERE m.migration_id=? AND o.action='upsert'`, input.migrationId) !== vectorRepairRows)
            throw new Error("principal-scope transaction exceeded or missed its exact boundary");
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (integrity !== "ok" || foreignKeyViolations !== 0) {
            throw new Error("principal-scope database verification failed before commit");
        }
        db.exec("COMMIT");
        const appliedStored = db.prepare("SELECT * FROM clawlore_principal_scope_migrations WHERE migration_id=?")
            .get(input.migrationId);
        if (!appliedStored)
            throw new Error("principal-scope committed receipt is missing");
        db.close();
        return receiptFromStored({ row: appliedStored, plan: plan.value, idempotentReplay: false });
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* preserve original error */ }
        try {
            db.close();
        }
        catch { /* preserve original error */ }
        throw error;
    }
}
