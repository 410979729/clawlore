import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { findSecret, redactKnownSecrets } from "../../secret-redaction.js";
import { quoteIdentifier, scanPersistedSecretDatabase, } from "../../persisted-secret-scan.js";
import { PERSISTED_SECRET_VECTOR_FIELDS } from "../../persisted-secret-policy.js";
import { inspectOwnerOnlySqliteFamily, inspectOwnerOnlyTree, tightenOwnerOnlySqliteFamily, tightenOwnerOnlyTree, } from "../../persisted-store-permissions.js";
const require = createRequire(import.meta.url);
export class PersistedSecretRemediationRecoveryRequiredError extends Error {
    code = "CLAWLORE_PERSISTED_SECRET_REMEDIATION_RECOVERY_REQUIRED";
    rollbackRequired = true;
    cause;
    constructor(cause) {
        super("persisted-secret remediation crossed an external or committed mutation boundary; "
            + "restore the verified encrypted snapshots and rebuild the vector companion before retry");
        this.name = "PersistedSecretRemediationRecoveryRequiredError";
        this.cause = cause;
    }
}
const PURGE_TABLES = new Set([
    "memory_truth",
    "memory_truth_fts",
    "memory_items",
    "memory_revisions",
    "memory_fts_v2",
    "memory_fts_compat_v2",
]);
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function opaquePath(path) {
    return sha256(resolve(path));
}
function tableExists(db, table) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function columnExists(db, table, column) {
    if (!tableExists(db, table))
        return false;
    return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
        .some((entry) => String(entry.name) === column);
}
function openDatabase(path, readOnly) {
    const { DatabaseSync: Database } = require("node:sqlite");
    const db = new Database(path, { readOnly });
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
    if (readOnly)
        db.exec("PRAGMA query_only=ON;");
    return db;
}
function addHitIdentity(hit, v1Ids, v2Ids) {
    if (hit.table === "memory_truth") {
        v1Ids.add(String(hit.row.id));
        return true;
    }
    if (hit.table === "memory_truth_fts") {
        v1Ids.add(String(hit.row.memory_id));
        return true;
    }
    if (hit.table === "memory_items" || hit.table === "memory_revisions") {
        v2Ids.add(String(hit.row.item_id));
        return true;
    }
    if (hit.table === "memory_fts_v2" || hit.table === "memory_fts_compat_v2") {
        v2Ids.add(String(hit.row.item_id));
        return true;
    }
    return false;
}
function expandMirrorIdentities(db, v1Ids, v2Ids) {
    let changed = true;
    while (changed) {
        const before = v1Ids.size + v2Ids.size;
        if (tableExists(db, "memory_items")) {
            for (const id of v1Ids) {
                const itemId = `legacy:${id}`;
                if (db.prepare("SELECT 1 FROM memory_items WHERE item_id=?").get(itemId))
                    v2Ids.add(itemId);
            }
        }
        for (const itemId of v2Ids) {
            if (itemId.startsWith("legacy:"))
                v1Ids.add(itemId.slice("legacy:".length));
            if (tableExists(db, "memory_vector_projection_v2")) {
                const row = db.prepare("SELECT legacy_id FROM memory_vector_projection_v2 WHERE item_id=?").get(itemId);
                if (row?.legacy_id)
                    v1Ids.add(String(row.legacy_id));
            }
        }
        changed = before !== v1Ids.size + v2Ids.size;
    }
}
function redactionTarget(kind, hit) {
    const after = redactKnownSecrets(hit.value);
    if (after === hit.value || findSecret(after)) {
        throw new Error(`persisted secret redaction failed closed for ${kind}.${hit.table}.${hit.field}`);
    }
    return {
        kind,
        table: hit.table,
        field: hit.field,
        rowid: hit.rowid,
        before: hit.value,
        after,
        beforeSha256: hit.payloadSha256,
        afterSha256: sha256(after),
    };
}
function sortedPatternCounts(hits) {
    const counts = {};
    for (const hit of hits)
        counts[hit.pattern] = (counts[hit.pattern] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
export async function buildPersistedSecretRemediationPlan(input) {
    const memory = openDatabase(input.memoryDbPath, true);
    const conversation = openDatabase(input.conversationDbPath, true);
    try {
        const memoryScan = scanPersistedSecretDatabase(memory, "memory");
        const conversationScan = scanPersistedSecretDatabase(conversation, "conversation");
        const vectorRows = await input.vector.listRows();
        const vectorHits = [];
        for (const row of vectorRows) {
            for (const field of PERSISTED_SECRET_VECTOR_FIELDS) {
                const value = String(row[field] ?? "");
                const secret = value ? findSecret(value) : null;
                if (secret)
                    vectorHits.push({ id: row.id, field, pattern: secret.name, payloadSha256: sha256(value) });
            }
        }
        const v1Ids = new Set(vectorHits.map((hit) => hit.id));
        const v2Ids = new Set();
        const redactions = [];
        for (const hit of memoryScan.hits) {
            if (!addHitIdentity(hit, v1Ids, v2Ids) && !PURGE_TABLES.has(hit.table)) {
                redactions.push(redactionTarget("memory", hit));
            }
        }
        for (const hit of conversationScan.hits)
            redactions.push(redactionTarget("conversation", hit));
        expandMirrorIdentities(memory, v1Ids, v2Ids);
        const vectorRowIds = new Set(vectorRows.map((row) => row.id));
        const vectorIds = [...v1Ids].filter((id) => vectorRowIds.has(id)).sort();
        const sortedV1 = [...v1Ids].sort();
        const sortedV2 = [...v2Ids].sort();
        redactions.sort((left, right) => `${left.kind}\0${left.table}\0${left.rowid}\0${left.field}`
            .localeCompare(`${right.kind}\0${right.table}\0${right.rowid}\0${right.field}`));
        const stateMaterial = [
            ...memoryScan.hits.map((hit) => `memory\0${hit.table}\0${hit.rowid}\0${hit.field}\0${hit.payloadSha256}`),
            ...conversationScan.hits.map((hit) => `conversation\0${hit.table}\0${hit.rowid}\0${hit.field}\0${hit.payloadSha256}`),
            ...vectorHits.map((hit) => `vector\0${sha256(hit.id)}\0${hit.field}\0${hit.payloadSha256}`),
        ].sort();
        const sourceStateDigest = sha256(JSON.stringify(stateMaterial));
        const targets = {
            v1MemoryItems: sortedV1.length,
            v2MemoryItems: sortedV2.length,
            vectorItems: vectorIds.length,
            redactionRows: new Set(redactions.map((entry) => `${entry.kind}:${entry.table}:${entry.rowid}`)).size,
            redactionFields: redactions.length,
        };
        const patternCounts = sortedPatternCounts([
            ...memoryScan.hits,
            ...conversationScan.hits,
            ...vectorHits,
        ]);
        // Bind the opaque identities as well as the hit payloads. Projection links
        // can change which V1/V2/vector rows are selected without changing the
        // secret-bearing field itself or the target counts.
        const targetIdentityDigest = sha256(JSON.stringify({
            v1: sortedV1.map(sha256),
            v2: sortedV2.map(sha256),
            vector: vectorIds.map(sha256),
            redactions: redactions.map((entry) => ({
                kind: entry.kind,
                table: entry.table,
                rowid: entry.rowid,
                field: entry.field,
                beforeSha256: entry.beforeSha256,
                afterSha256: entry.afterSha256,
            })),
        }));
        const planDigest = sha256(JSON.stringify({
            sourceStateDigest,
            targetIdentityDigest,
            targets,
            patternCounts,
        }));
        const receipt = {
            schemaVersion: 1,
            phase: "clawlore-persisted-secret-remediation-plan",
            plannedAt: (input.now?.() ?? new Date()).toISOString(),
            status: Object.values(targets).some((value) => value > 0) ? "ready" : "clean",
            readOnly: true,
            emitsSecretValues: false,
            emitsMemoryContent: false,
            emitsRawIdentifiers: false,
            sourceRefs: {
                memory: opaquePath(input.memoryDbPath),
                conversation: opaquePath(input.conversationDbPath),
                vector: opaquePath(input.vectorPath),
            },
            preAudit: {
                memoryFields: memoryScan.summary.secretBearingFields,
                conversationFields: conversationScan.summary.secretBearingFields,
                vectorFields: vectorHits.length,
            },
            targets,
            patternCounts,
            sourceStateDigest,
            targetIdentityDigest,
            planDigest,
            permissionFixRequired: [
                inspectOwnerOnlySqliteFamily(input.memoryDbPath).ownerOnly,
                inspectOwnerOnlySqliteFamily(input.conversationDbPath).ownerOnly,
                inspectOwnerOnlyTree(input.vectorPath).ownerOnly,
            ].some((value) => value === false),
            decision: {
                authorizesApply: false,
                requiresExplicitApproval: true,
                requiresVerifiedEncryptedSnapshots: true,
                requiresVerifiedVectorSnapshot: true,
                requiresCredentialRotationBeforeApply: true,
            },
        };
        return { receipt, internal: { v1Ids: sortedV1, v2Ids: sortedV2, vectorIds, redactions } };
    }
    finally {
        memory.close();
        conversation.close();
    }
}
function deleteWhere(db, table, column, value) {
    if (!columnExists(db, table, column))
        return;
    db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)}=?`).run(value);
}
function purgeV1Memory(db, id) {
    deleteWhere(db, "memory_digest_sources", "memory_id", id);
    deleteWhere(db, "vector_companion_repair_outbox", "memory_id", id);
    deleteWhere(db, "memory_truth_fts", "memory_id", id);
    deleteWhere(db, "memory_truth", "id", id);
}
function purgeV2Memory(db, itemId, now) {
    // FTS/projection scans can surface stale orphan rows. Only identities owned
    // by the V2 truth ledger may receive a purge event/outbox record; inserting
    // ledger rows for an orphan would either violate the FK or manufacture an
    // identity that never existed.
    const hasIdentity = tableExists(db, "memory_item_identities")
        && Boolean(db.prepare("SELECT 1 FROM memory_item_identities WHERE item_id=?").get(itemId));
    if (tableExists(db, "projection_outbox_claims") && tableExists(db, "projection_outbox")) {
        db.prepare(`DELETE FROM projection_outbox_claims WHERE outbox_id IN
      (SELECT outbox_id FROM projection_outbox WHERE item_id=?)`).run(itemId);
    }
    deleteWhere(db, "memory_fts_v2", "item_id", itemId);
    deleteWhere(db, "memory_fts_compat_v2", "item_id", itemId);
    deleteWhere(db, "memory_vector_projection_v2", "item_id", itemId);
    deleteWhere(db, "memory_relation_projection_v2", "item_id", itemId);
    if (tableExists(db, "memory_relations") && tableExists(db, "memory_revisions")) {
        db.prepare(`DELETE FROM memory_relations WHERE from_revision_id IN
      (SELECT revision_id FROM memory_revisions WHERE item_id=?) OR to_revision_id IN
      (SELECT revision_id FROM memory_revisions WHERE item_id=?)`).run(itemId, itemId);
    }
    if (tableExists(db, "memory_sources") && tableExists(db, "memory_revisions")) {
        db.prepare(`DELETE FROM memory_sources WHERE revision_id IN
      (SELECT revision_id FROM memory_revisions WHERE item_id=?)`).run(itemId);
    }
    deleteWhere(db, "memory_acl", "item_id", itemId);
    deleteWhere(db, "memory_revisions", "item_id", itemId);
    deleteWhere(db, "memory_items", "item_id", itemId);
    if (hasIdentity && columnExists(db, "memory_item_identities", "purged_at")) {
        db.prepare("UPDATE memory_item_identities SET purged_at=? WHERE item_id=?").run(now, itemId);
    }
    if (hasIdentity && tableExists(db, "memory_events")) {
        db.prepare(`INSERT INTO memory_events
      (event_id,item_id,revision_id,event_type,actor,reason,created_at)
      VALUES (?,?,NULL,'purged','operator:security-remediation','persisted-secret-remediation',?)`)
            .run(randomUUID(), itemId, now);
    }
    if (hasIdentity && tableExists(db, "projection_outbox")) {
        const statement = db.prepare(`INSERT INTO projection_outbox
      (outbox_id,item_id,revision_id,operation,projection,attempts,available_at,created_at,processed_at,last_error)
      VALUES (?,?,NULL,'purge',?,0,?,?,?,NULL)`);
        for (const projection of ["fts", "vector", "relations"]) {
            statement.run(randomUUID(), itemId, projection, now, now, now);
        }
    }
}
function applyRedaction(db, target) {
    const result = db.prepare(`UPDATE ${quoteIdentifier(target.table)}
    SET ${quoteIdentifier(target.field)}=?
    WHERE rowid=? AND ${quoteIdentifier(target.field)}=?`).run(target.after, target.rowid, target.before);
    if (Number(result.changes) !== 1) {
        throw new Error(`persisted secret target drifted: ${target.table}.${target.field}`);
    }
}
function verifyDatabase(db, kind) {
    const scan = scanPersistedSecretDatabase(db, kind);
    if (scan.summary.secretBearingFields !== 0) {
        throw new Error(`${kind} post-remediation persisted-secret audit is not clean`);
    }
    const integrityRow = db.prepare("PRAGMA integrity_check").get();
    const integrity = String(integrityRow.integrity_check ?? Object.values(integrityRow)[0] ?? "");
    if (integrity !== "ok")
        throw new Error(`${kind} database integrity check failed`);
    return "ok";
}
function foreignKeyViolations(db) {
    return db.prepare("PRAGMA foreign_key_check").all().length;
}
export async function executePersistedSecretRemediation(input) {
    if (input.approved !== true)
        throw new Error("persisted secret remediation requires explicit approval");
    if (input.snapshotsVerified !== true)
        throw new Error("persisted secret remediation requires verified encrypted snapshots");
    if (input.vectorSnapshotVerified !== true) {
        throw new Error("persisted secret remediation requires a verified encrypted vector snapshot");
    }
    if (input.credentialsRotated !== true)
        throw new Error("persisted secret remediation requires credential rotation first");
    if (input.tightenPermissions !== true)
        throw new Error("persisted secret remediation requires permission tightening");
    const plan = await buildPersistedSecretRemediationPlan(input);
    if (!/^[a-f0-9]{64}$/.test(input.expectedPlanDigest)
        || input.expectedPlanDigest !== plan.receipt.planDigest) {
        throw new Error("persisted secret remediation plan digest mismatch");
    }
    const memory = openDatabase(input.memoryDbPath, false);
    const conversation = openDatabase(input.conversationDbPath, false);
    const appliedAt = (input.now?.() ?? new Date()).toISOString();
    let memoryCommitted = false;
    let conversationCommitted = false;
    let externalMutationAttempted = false;
    try {
        memory.exec("BEGIN IMMEDIATE");
        conversation.exec("BEGIN IMMEDIATE");
        for (const target of plan.internal.redactions) {
            applyRedaction(target.kind === "memory" ? memory : conversation, target);
        }
        for (const id of plan.internal.v1Ids)
            purgeV1Memory(memory, id);
        for (const itemId of plan.internal.v2Ids)
            purgeV2Memory(memory, itemId, appliedAt);
        // LanceDB is outside the SQLite transactions. Once this call begins, any
        // failure must conservatively require snapshot restore/vector rebuild;
        // never imply that rolling back the SQL handles restored the whole state.
        externalMutationAttempted = true;
        const vectorDeleted = await input.vector.deleteIds(plan.internal.vectorIds);
        if (vectorDeleted !== plan.internal.vectorIds.length) {
            throw new Error("vector remediation did not delete every planned item");
        }
        const residualVector = (await input.vector.listRows()).flatMap((row) => PERSISTED_SECRET_VECTOR_FIELDS.map((field) => findSecret(String(row[field] ?? ""))).filter(Boolean));
        if (residualVector.length !== 0)
            throw new Error("vector post-remediation persisted-secret audit is not clean");
        const memoryIntegrity = verifyDatabase(memory, "memory");
        const conversationIntegrity = verifyDatabase(conversation, "conversation");
        const fk = foreignKeyViolations(memory) + foreignKeyViolations(conversation);
        if (fk !== 0)
            throw new Error("post-remediation foreign key check failed");
        memory.exec("COMMIT");
        memoryCommitted = true;
        conversation.exec("COMMIT");
        conversationCommitted = true;
        memory.close();
        conversation.close();
        tightenOwnerOnlySqliteFamily(input.memoryDbPath);
        tightenOwnerOnlySqliteFamily(input.conversationDbPath);
        tightenOwnerOnlyTree(input.vectorPath);
        const post = await buildPersistedSecretRemediationPlan(input);
        if (post.receipt.status !== "clean")
            throw new Error("persisted secret remediation post-plan is not clean");
        return {
            schemaVersion: 1,
            phase: "clawlore-persisted-secret-remediation-apply",
            appliedAt,
            status: "pass",
            emitsSecretValues: false,
            emitsMemoryContent: false,
            emitsRawIdentifiers: false,
            planDigest: plan.receipt.planDigest,
            snapshotsVerified: true,
            vectorSnapshotVerified: true,
            credentialsRotatedBeforeApply: true,
            permissionsTightened: true,
            applied: plan.receipt.targets,
            postAudit: { memoryFields: 0, conversationFields: 0, vectorFields: 0 },
            integrity: { memory: memoryIntegrity, conversation: conversationIntegrity, foreignKeyViolations: 0 },
            rollbackRequired: false,
        };
    }
    catch (error) {
        if (!memoryCommitted)
            try {
                memory.exec("ROLLBACK");
            }
            catch { }
        if (!conversationCommitted)
            try {
                conversation.exec("ROLLBACK");
            }
            catch { }
        if (externalMutationAttempted || memoryCommitted || conversationCommitted) {
            throw new PersistedSecretRemediationRecoveryRequiredError(error);
        }
        throw error;
    }
    finally {
        try {
            memory.close();
        }
        catch { }
        try {
            conversation.close();
        }
        catch { }
    }
}
