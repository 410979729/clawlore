import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolvePrincipalWriteTarget } from "../../principal-write-boundary.js";
import { resolveRuntimeMemoryBoundary } from "../../runtime-memory-boundary.js";
import { classifyLegacyPrincipalAttributionV1, } from "../migration/legacy-principal-attribution.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
const require = createRequire(import.meta.url);
export function computeLegacyPrincipalTruthStateDigestV1(row) {
    return hash(stableJson({
        legacyId: row.id,
        contentSha256: hash(String(row.text)),
        category: row.category,
        scope: row.scope,
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadataSha256: hash(String(row.metadata)),
        metadataTextSha256: hash(String(row.metadata_text)),
        updatedAt: Number(row.updated_at),
    }));
}
export function computePrincipalV2StateDigestV1(input) {
    return hash(stableJson(input));
}
const LANES = [
    "target_private_source_scope",
    "target_private_already_assigned",
    "target_private_unexpected_scope",
    "other_private_session",
    "conversation_session",
    "conflicting_session_reference",
    "malformed_session_reference",
    "derived_system_reference",
    "manual_unattributed",
    "opaque_session_reference",
    "no_identity_reference",
    "invalid_metadata",
];
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function scalar(db, sql) {
    const row = db.prepare(sql).get();
    return Number(Object.values(row)[0] ?? 0);
}
function hasTable(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
function planCore(plan) {
    return {
        schemaVersion: plan.schemaVersion,
        phase: plan.phase,
        proposedMigrationId: plan.proposedMigrationId,
        readOnly: plan.readOnly,
        queryOnly: plan.queryOnly,
        emitsMemoryContent: plan.emitsMemoryContent,
        emitsTranscriptContent: plan.emitsTranscriptContent,
        emitsRawIdentifiers: plan.emitsRawIdentifiers,
        target: plan.target,
        source: plan.source,
        lanes: plan.lanes,
        summary: plan.summary,
        rows: plan.rows,
        decision: plan.decision,
        authorizesScopeMutation: plan.authorizesScopeMutation,
        authorizesLifecycleMutation: plan.authorizesLifecycleMutation,
        authorizesContextEngine: plan.authorizesContextEngine,
        authorizesPromptMutation: plan.authorizesPromptMutation,
        authorizesFinalRecall: plan.authorizesFinalRecall,
    };
}
export function computeLivePrincipalScopePlanDigestV1(plan) {
    const { createdAt: _createdAt, planDigest: _planDigest, ...withoutDigest } = plan;
    return hash(stableJson(planCore(withoutDigest)));
}
export async function createLivePrincipalScopePlanV1(input) {
    if (!/^[a-z0-9][a-z0-9._-]{7,127}$/i.test(input.proposedMigrationId)) {
        throw new Error("proposed principal-scope migration id is invalid");
    }
    if (!input.sourceScope || input.sourceScope !== input.sourceScope.trim()) {
        throw new Error("principal-scope source scope must be explicit and trimmed");
    }
    const target = resolvePrincipalWriteTarget({ sessionKey: input.targetSessionKey });
    const boundary = resolveRuntimeMemoryBoundary({ runtimeContext: { sessionKey: input.targetSessionKey } });
    if (target.kind !== "private"
        || !target.principalHash
        || boundary.kind !== "private"
        || !boundary.principalKey)
        throw new Error("principal-scope target must resolve to one exact private principal");
    const before = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (before.integrity !== "ok" || before.foreignKeyViolations !== 0) {
        throw new Error("principal-scope source integrity check failed");
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
    const lanes = Object.fromEntries(LANES.map((lane) => [lane, 0]));
    const rows = [];
    let ftsRows = 0;
    let lifecycleProjectionRows = 0;
    let v2Rows = 0;
    try {
        ftsRows = scalar(db, "SELECT COUNT(*) FROM memory_truth_fts");
        const hasLifecycleProjection = hasTable(db, "memory_lifecycle_projection");
        lifecycleProjectionRows = hasLifecycleProjection
            ? scalar(db, "SELECT COUNT(*) FROM memory_lifecycle_projection")
            : 0;
        v2Rows = scalar(db, "SELECT COUNT(*) FROM memory_items");
        const truthRows = db.prepare(`SELECT id,text,category,scope,importance,timestamp,metadata,
      metadata_text,updated_at FROM memory_truth ORDER BY id`).all();
        const v2Statement = db.prepare(`SELECT item_id,current_revision_id,address_json,principal_id,
      visibility,lifecycle,verification FROM memory_items WHERE item_id=?`);
        const aclStatement = db.prepare(`SELECT acl_id,owner_principal_id,visibility,policy_json,created_at
      FROM memory_acl WHERE item_id=? ORDER BY acl_id`);
        const sourceStatement = db.prepare(`SELECT source_id,evidence_json FROM memory_sources
      WHERE revision_id=? ORDER BY source_id`);
        const ftsStatement = db.prepare("SELECT COUNT(*) AS rows FROM memory_truth_fts WHERE memory_id=?");
        const lifecycleStatement = hasLifecycleProjection
            ? db.prepare(`SELECT scope,truth_updated_at FROM memory_lifecycle_projection WHERE memory_id=?`)
            : undefined;
        for (const row of truthRows) {
            const attribution = classifyLegacyPrincipalAttributionV1({
                metadata: String(row.metadata || "{}"),
                currentScope: String(row.scope),
                sourceScope: input.sourceScope,
                targetScope: target.scope,
                targetSessionKey: input.targetSessionKey,
            });
            lanes[attribution.lane] += 1;
            if (!attribution.targetEvidence)
                continue;
            const itemId = `legacy:${row.id}`;
            const v2 = v2Statement.get(itemId);
            const acl = v2 ? aclStatement.all(itemId) : [];
            const sources = v2
                ? sourceStatement.all(v2.current_revision_id)
                : [];
            const lifecycle = lifecycleStatement?.get(row.id);
            const v2AddressCompatible = !v2
                || v2.principal_id === "legacy:unresolved"
                || v2.principal_id === boundary.principalKey;
            const principalAssignmentEligible = attribution.migrationEligible
                || attribution.lane === "target_private_already_assigned";
            rows.push({
                legacyIdSha256: hash(row.id),
                itemIdSha256: hash(itemId),
                currentStateDigest: computeLegacyPrincipalTruthStateDigestV1(row),
                lane: attribution.lane,
                evidenceFields: attribution.evidenceFields,
                referenceDigest: attribution.referenceDigest ?? hash(""),
                principalAssignmentEligible,
                migrationEligible: attribution.migrationEligible,
                v2Mirrored: Boolean(v2),
                ...(v2 ? { v2StateDigest: computePrincipalV2StateDigestV1({
                        v2: v2, acl, sources,
                    }) } : {}),
                v2AddressCompatible,
                ftsReady: Number(ftsStatement.get(row.id)?.rows ?? 0) === 1,
                lifecycleProjectionReady: Boolean(lifecycle
                    && lifecycle.scope === row.scope
                    && Number(lifecycle.truth_updated_at) === Number(row.updated_at)),
                aclReady: !v2 || acl.length === 1,
                currentSourceReady: !v2 || sources.length === 1,
            });
        }
    }
    finally {
        db.close();
    }
    rows.sort((left, right) => left.legacyIdSha256.localeCompare(right.legacyIdSha256));
    const assignmentRows = rows.filter((row) => row.principalAssignmentEligible);
    const migrationRows = rows.filter((row) => row.migrationEligible);
    const summary = {
        targetEvidenceRows: rows.length,
        principalAssignmentRows: assignmentRows.length,
        migrationEligibleRows: migrationRows.length,
        alreadyAssignedRows: rows.filter((row) => row.lane === "target_private_already_assigned").length,
        unexpectedTargetScopeRows: rows.filter((row) => row.lane === "target_private_unexpected_scope").length,
        v2MirroredAssignmentRows: assignmentRows.filter((row) => row.v2Mirrored).length,
        unmirroredAssignmentRows: assignmentRows.filter((row) => !row.v2Mirrored).length,
        incompatibleV2AssignmentRows: assignmentRows.filter((row) => !row.v2AddressCompatible).length,
        ftsUnreadyAssignmentRows: assignmentRows.filter((row) => !row.ftsReady).length,
        lifecycleProjectionUnreadyAssignmentRows: assignmentRows.filter((row) => !row.lifecycleProjectionReady).length,
        aclUnreadyAssignmentRows: assignmentRows.filter((row) => !row.aclReady).length,
        currentSourceUnreadyAssignmentRows: assignmentRows.filter((row) => !row.currentSourceReady).length,
    };
    const assignmentReady = assignmentRows.length > 0
        && migrationRows.length > 0
        && summary.unmirroredAssignmentRows === 0
        && summary.incompatibleV2AssignmentRows === 0
        && summary.ftsUnreadyAssignmentRows === 0
        && summary.lifecycleProjectionUnreadyAssignmentRows === 0
        && summary.aclUnreadyAssignmentRows === 0
        && summary.currentSourceUnreadyAssignmentRows === 0
        && summary.unexpectedTargetScopeRows === 0
        && ftsRows === before.memoryTruth.rowCount
        && lifecycleProjectionRows === before.memoryTruth.rowCount;
    const after = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (after.schemaDigest !== before.schemaDigest
        || after.memoryTruth.rowCount !== before.memoryTruth.rowCount
        || after.memoryTruth.logicalDigest !== before.memoryTruth.logicalDigest)
        throw new Error("principal-scope source changed during planning");
    const withoutDigest = {
        schemaVersion: 1,
        phase: "clawlore-live-principal-scope-plan",
        proposedMigrationId: input.proposedMigrationId,
        readOnly: true,
        queryOnly: true,
        emitsMemoryContent: false,
        emitsTranscriptContent: false,
        emitsRawIdentifiers: false,
        target: {
            contract: target.contract,
            kind: "private",
            scope: target.scope,
            principalHash: target.principalHash,
            sessionKeySha256: hash(input.targetSessionKey),
            sourceScopeSha256: hash(input.sourceScope),
        },
        source: {
            memoryTruthRows: before.memoryTruth.rowCount,
            memoryTruthLogicalDigest: before.memoryTruth.logicalDigest,
            schemaDigest: before.schemaDigest,
            ftsRows,
            lifecycleProjectionRows,
            v2Rows,
            integrity: "ok",
            foreignKeyViolations: 0,
            sourceUnchangedDuringPlan: true,
        },
        lanes,
        summary,
        rows,
        decision: {
            assignmentReady,
            requiresFreshEncryptedSnapshot: true,
            automaticLifecyclePromotionRows: 0,
            finalRecallCutoverReady: false,
        },
        authorizesScopeMutation: false,
        authorizesLifecycleMutation: false,
        authorizesContextEngine: false,
        authorizesPromptMutation: false,
        authorizesFinalRecall: false,
    };
    return {
        ...withoutDigest,
        createdAt: (input.now?.() ?? new Date()).toISOString(),
        planDigest: hash(stableJson(planCore(withoutDigest))),
    };
}
