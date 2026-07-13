import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
const require = createRequire(import.meta.url);
const CONTROL_MAX_BYTES = 5 * 1024 * 1024;
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function privateJson(path) {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > CONTROL_MAX_BYTES) {
        throw new Error("append-delta acceptance control must be a non-empty owner-only file");
    }
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("append-delta acceptance control JSON is invalid");
    }
    return { value, sha256: hash(bytes) };
}
function scalar(db, sql) {
    return Number(Object.values(db.prepare(sql).get())[0] ?? 0);
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
function validateControls(input) {
    const { plan, planSha256, apply } = input;
    const classifications = plan.proposed.classifications;
    const supportedClassifications = Object.entries(classifications)
        .filter(([, rows]) => rows !== 0)
        .every(([classification]) => classification === "reflection_summary"
        || classification === "operational_checkpoint");
    if (plan.schemaVersion !== 1
        || plan.phase !== "clawlore-v1-append-delta-plan"
        || plan.readOnly !== true
        || plan.queryOnly !== true
        || plan.emitsMemoryContent !== false
        || plan.emitsRawIdentifiers !== false
        || plan.source.deltaRows <= 0
        || plan.proposed.rows.length !== plan.source.deltaRows
        || plan.proposed.planDigest !== hash(JSON.stringify(plan.proposed.rows))
        || plan.proposed.candidateRows !== plan.source.deltaRows
        || plan.proposed.activeRows !== 0
        || plan.proposed.archivedRows !== 0
        || plan.proposed.verifications.unverified !== plan.source.deltaRows
        || plan.proposed.verificationDebt.legacy_identity !== plan.source.deltaRows
        || plan.proposed.reviewRequiredRows !== plan.source.deltaRows
        || plan.proposed.invalidMetadataRows !== 0
        || !supportedClassifications
        || (classifications.reflection_summary ?? 0) + (classifications.operational_checkpoint ?? 0)
            !== plan.source.deltaRows
        || plan.decision.deltaWriteReady !== true
        || plan.authorizesDeltaWrite !== false
        || apply.schemaVersion !== 1
        || apply.phase !== "clawlore-v2-live-v1-append-delta"
        || apply.status !== "applied"
        || apply.rolloutId !== plan.proposedRolloutId
        || apply.planDigest !== plan.proposed.planDigest
        || apply.planSha256 !== planSha256
        || apply.source.v1Rows !== plan.source.v1Rows
        || apply.source.memoryTruthLogicalDigest !== plan.source.memoryTruthLogicalDigest
        || apply.source.unchanged !== true
        || apply.v2.beforeRows !== plan.source.v2Rows
        || apply.v2.afterRows !== plan.source.v2Rows + plan.source.deltaRows
        || apply.v2.deltaRows !== plan.source.deltaRows
        || apply.v2.existingCanonicalRowsChanged !== 0
        || apply.v2.existingLifecycleRowsChanged !== 0
        || apply.v2.existingVerificationRowsChanged !== 0
        || apply.v2.existingEvidenceRowsChanged !== 0
        || apply.database.integrity !== "ok"
        || apply.database.foreignKeyViolations !== 0
        || apply.runtime.existingCandidateLifecycleMutationEnabled !== false
        || apply.runtime.contextEngineEnabled !== false
        || apply.runtime.promptMutationEnabled !== false
        || apply.runtime.finalRecallCutoverEnabled !== false)
        throw new Error("append-delta acceptance controls are invalid or exceed the conservative lane");
}
export async function createLiveV1AppendDeltaAcceptanceV1(input) {
    const loadedPlan = privateJson(input.planPath);
    const loadedApply = privateJson(input.applyReceiptPath);
    validateControls({ plan: loadedPlan.value, planSha256: loadedPlan.sha256, apply: loadedApply.value });
    const legacyBefore = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (legacyBefore.memoryTruth.rowCount !== loadedApply.value.source.v1Rows
        || legacyBefore.memoryTruth.logicalDigest !== loadedApply.value.source.memoryTruthLogicalDigest) {
        throw new Error("live V1 source no longer matches the accepted append rollout");
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath, { readOnly: true });
    let result;
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const deltaRows = db.prepare(`SELECT i.item_id,i.content,i.lifecycle,i.verification,i.address_json,
      s.external_id,s.evidence_json FROM memory_items i
      JOIN memory_sources s ON s.revision_id=i.current_revision_id
      ORDER BY i.item_id,s.source_id`).all();
        const rolloutRows = deltaRows.filter((row) => parseRecord(row.evidence_json).rolloutId === loadedApply.value.rolloutId);
        const planByLegacy = new Map(loadedPlan.value.proposed.rows.map((row) => [row.legacyIdSha256, row]));
        if (rolloutRows.length !== loadedPlan.value.source.deltaRows
            || new Set(rolloutRows.map((row) => hash(row.external_id))).size !== rolloutRows.length) {
            throw new Error("live append rollout rows are missing, duplicated, or unplanned");
        }
        for (const row of rolloutRows) {
            const planned = planByLegacy.get(hash(row.external_id));
            const evidence = parseRecord(row.evidence_json);
            const address = parseRecord(row.address_json);
            if (!planned
                || hash(row.content) !== planned.contentSha256
                || hash(row.address_json) !== planned.addressSha256
                || row.lifecycle !== planned.lifecycle
                || row.verification !== planned.verification
                || evidence.classification !== planned.classification
                || evidence.reviewRequired !== planned.reviewRequired
                || evidence.verificationDebt !== planned.verificationDebt
                || evidence.appendOnlyV1Delta !== true
                || address.principalId !== "legacy:unresolved") {
                throw new Error("live append rollout row no longer matches its exact redacted plan binding");
            }
        }
        const lifecycle = Object.fromEntries(db.prepare(`SELECT lifecycle,COUNT(*) AS rows FROM memory_items
      GROUP BY lifecycle ORDER BY lifecycle`).all()
            .map((row) => [row.lifecycle, Number(row.rows)]));
        const v2Rows = scalar(db, "SELECT COUNT(*) FROM memory_items");
        const compatibilityRows = scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2");
        const ftsRows = scalar(db, "SELECT COUNT(*) FROM memory_fts_v2");
        const vectorRows = scalar(db, "SELECT COUNT(*) FROM memory_vector_projection_v2");
        const relationRows = scalar(db, "SELECT COUNT(*) FROM memory_relation_projection_v2");
        const pendingOutboxRows = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL");
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        const missingV2 = scalar(db, `SELECT COUNT(*) FROM memory_truth l LEFT JOIN memory_items i
      ON i.item_id='legacy:' || l.id WHERE i.item_id IS NULL`);
        const missingV1 = scalar(db, `SELECT COUNT(*) FROM memory_items i LEFT JOIN memory_truth l
      ON i.item_id='legacy:' || l.id WHERE l.id IS NULL`);
        if (v2Rows !== loadedApply.value.v2.afterRows
            || Number(lifecycle.active ?? 0) !== loadedApply.value.v2.activeRows
            || Number(lifecycle.candidate ?? 0) !== loadedApply.value.v2.candidateRows
            || Number(lifecycle.archived ?? 0) !== loadedApply.value.v2.archivedRows
            || compatibilityRows !== loadedApply.value.projections.compatibilityRows
            || ftsRows !== loadedApply.value.projections.ftsRows
            || vectorRows !== loadedApply.value.projections.vectorRows
            || relationRows !== loadedApply.value.projections.relationProjectionRows
            || pendingOutboxRows !== 0
            || integrity !== "ok"
            || foreignKeyViolations !== 0
            || missingV1 !== 0
            || missingV2 !== 0
            || v2Rows !== legacyBefore.memoryTruth.rowCount
            || vectorRows !== v2Rows) {
            throw new Error("live append rollout projections or database state are not converged");
        }
        result = {
            schemaVersion: 1,
            phase: "clawlore-v2-live-v1-append-delta-acceptance",
            rolloutId: loadedApply.value.rolloutId,
            status: "pass",
            verifiedAt: (input.now?.() ?? new Date()).toISOString(),
            planDigest: loadedApply.value.planDigest,
            source: { v1Rows: legacyBefore.memoryTruth.rowCount, v2Rows, sourceLogicalDigestUnchanged: true },
            delta: {
                rows: rolloutRows.length,
                reflectionSummaryRows: rolloutRows.filter((row) => parseRecord(row.evidence_json).classification
                    === "reflection_summary").length,
                operationalCheckpointRows: rolloutRows.filter((row) => parseRecord(row.evidence_json).classification
                    === "operational_checkpoint").length,
                candidateRows: rolloutRows.filter((row) => row.lifecycle === "candidate").length,
                unverifiedRows: rolloutRows.filter((row) => row.verification === "unverified").length,
                legacyIdentityDebtRows: rolloutRows.filter((row) => parseRecord(row.evidence_json).verificationDebt
                    === "legacy_identity").length,
            },
            preserved: {
                existingCanonicalRowsChanged: 0,
                existingLifecycleRowsChanged: 0,
                existingVerificationRowsChanged: 0,
                existingEvidenceRowsChanged: 0,
            },
            lifecycle: {
                activeRows: Number(lifecycle.active ?? 0),
                candidateRows: Number(lifecycle.candidate ?? 0),
                archivedRows: Number(lifecycle.archived ?? 0),
            },
            projections: {
                compatibilityRows,
                ftsRows,
                vectorRows,
                relationRows,
                newProcessedOutboxRows: loadedApply.value.projections.newProcessedOutboxRows,
                pendingOutboxRows: 0,
            },
            database: { integrity: "ok", foreignKeyViolations: 0, v1DoctorHealthy: true, sqlVectorScopeMatch: true },
            runtime: loadedApply.value.runtime,
        };
    }
    finally {
        db.close();
    }
    const legacyAfter = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (legacyAfter.memoryTruth.rowCount !== legacyBefore.memoryTruth.rowCount
        || legacyAfter.memoryTruth.logicalDigest !== legacyBefore.memoryTruth.logicalDigest) {
        throw new Error("live V1 source changed during append-delta acceptance");
    }
    return result;
}
