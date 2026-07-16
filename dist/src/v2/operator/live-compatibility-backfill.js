import { preparePrivateFileForRead } from "../../file-privacy.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { PHASE7G_LEGACY_SEARCH_FIELD_ALLOWLIST_V1, } from "../application/phase7g-rollout-controls.js";
import { buildLiveCompatibilityBackfillPlanV1, } from "./live-phase7g-preview.js";
import { inspectLegacySqliteSnapshotV2 } from "./legacy-v1-snapshot.js";
const require = createRequire(import.meta.url);
const PREVIEW_MAX_BYTES = 512 * 1024;
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function privateJson(path, maximumBytes) {
    if (process.platform === "win32")
        preparePrivateFileForRead(path);
    const info = statSync(path);
    if (!info.isFile())
        throw new Error("rollout control is not a file");
    if ((process.platform !== "win32" && (info.mode & 0o077) !== 0))
        throw new Error("rollout control permissions must be 0600");
    if (info.size <= 0 || info.size > maximumBytes)
        throw new Error("rollout control size is invalid");
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("rollout control is invalid");
    }
    return { value, sha256: sha256(bytes) };
}
function loadPreview(path, rolloutId, planDigest, now) {
    const loaded = privateJson(path, PREVIEW_MAX_BYTES);
    const value = loaded.value;
    const controls = value.controls;
    const expected = controls?.plans?.compatibilityBackfill;
    const previewTime = Date.parse(value.createdAt);
    const elapsedSincePreview = Number.isFinite(previewTime)
        ? Math.max(0, Math.floor((now.getTime() - previewTime) / 1000))
        : Number.POSITIVE_INFINITY;
    const snapshotAgeAtApply = (controls?.snapshot?.ageSeconds ?? Number.POSITIVE_INFINITY) + elapsedSincePreview;
    if (value.schemaVersion !== 1
        || value.phase !== "clawlore-phase7g-live-preview"
        || value.readOnly !== true
        || value.emitsMemoryContent !== false
        || value.sourceUnchanged !== true
        || value.compatibilityPlan?.planDigest !== planDigest
        || value.compatibilityPlan?.authorizesLiveMutation !== false
        || controls?.status !== "ready"
        || controls.blockers.length !== 0
        || expected?.rolloutId !== rolloutId
        || expected.mode !== "compatibility-backfill"
        || expected.planDigest !== planDigest
        || controls.authorizesCompatibilityBackfill !== false
        || controls.authorizesCandidatePromotion !== false
        || controls.authorizesContextEngine !== false
        || controls.authorizesPromptMutation !== false
        || controls.authorizesFinalRecallCutover !== false
        || value.liveMutation?.compatibilityProjectionCreated !== false
        || value.liveMutation?.lifecycleRowsChanged !== 0
        || snapshotAgeAtApply > controls.snapshot.maximumAgeSeconds)
        throw new Error("compatibility preview is invalid, stale, or exceeds the bounded plan");
    return { value, sha256: loaded.sha256 };
}
function scalar(db, sql, ...args) {
    const row = db.prepare(sql).get(...args);
    return Number(Object.values(row)[0] ?? 0);
}
function lifecycleCounts(db) {
    const rows = db.prepare("SELECT lifecycle,COUNT(*) AS rows FROM memory_items GROUP BY lifecycle ORDER BY lifecycle")
        .all();
    return Object.fromEntries(rows.map((row) => [row.lifecycle, Number(row.rows)]));
}
export async function executeLiveCompatibilityBackfillV1(input) {
    const appliedAtDate = input.now?.() ?? new Date();
    const preview = loadPreview(input.previewPath, input.rolloutId, input.planDigest, appliedAtDate);
    const before = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    if (before.memoryTruth.rowCount !== preview.value.controls.snapshot.sourceRows
        || before.memoryTruth.logicalDigest !== preview.value.controls.snapshot.sourceLogicalDigest)
        throw new Error("live legacy truth no longer matches the compatibility preview");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.sourcePath);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
    const preexisting = scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','view') AND name='memory_fts_compat_v2'");
    if (preexisting !== 0) {
        db.close();
        throw new Error("compatibility projection already exists");
    }
    const livePlan = buildLiveCompatibilityBackfillPlanV1(db);
    if (livePlan.planDigest !== input.planDigest
        || livePlan.planDigest !== preview.value.compatibilityPlan.planDigest
        || livePlan.sourceRows !== livePlan.v2Rows
        || livePlan.mappingMismatchRows !== 0
        || livePlan.existingProjectionRows !== 0) {
        db.close();
        throw new Error("live compatibility plan no longer matches the preview digest");
    }
    const beforeItems = scalar(db, "SELECT COUNT(*) FROM memory_items");
    const beforeLifecycle = lifecycleCounts(db);
    const beforePendingOutbox = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL");
    const rows = db.prepare(`SELECT i.item_id,i.content,l.metadata_text
    FROM memory_truth l JOIN memory_items i ON i.item_id='legacy:' || l.id ORDER BY l.id`).all();
    const appliedAt = appliedAtDate.toISOString();
    try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("CREATE VIRTUAL TABLE memory_fts_compat_v2 USING fts5(item_id UNINDEXED,content,metadata_text)");
        const insert = db.prepare("INSERT INTO memory_fts_compat_v2(item_id,content,metadata_text) VALUES (?,?,?)");
        for (const row of rows) {
            insert.run(row.item_id, row.content, row.metadata_text || "");
        }
        db.exec("COMMIT");
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* preserve original failure */ }
        db.close();
        throw error;
    }
    const projectionRows = scalar(db, "SELECT COUNT(*) FROM memory_fts_compat_v2");
    const afterItems = scalar(db, "SELECT COUNT(*) FROM memory_items");
    const afterLifecycle = lifecycleCounts(db);
    const afterPendingOutbox = scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL");
    const columns = db.prepare("PRAGMA table_info(memory_fts_compat_v2)").all()
        .map((row) => row.name);
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    db.close();
    const after = await inspectLegacySqliteSnapshotV2(input.sourcePath);
    const canonicalMemoryItemsChanged = afterItems - beforeItems;
    const lifecycleRowsChanged = JSON.stringify(afterLifecycle) === JSON.stringify(beforeLifecycle) ? 0 : 1;
    const pendingOutboxRowsChanged = afterPendingOutbox - beforePendingOutbox;
    if (projectionRows !== livePlan.expectedProjectionRows
        || rows.length !== livePlan.expectedProjectionRows
        || columns.join(",") !== "item_id,content,metadata_text"
        || integrity !== "ok"
        || foreignKeyViolations !== 0
        || after.memoryTruth.rowCount !== before.memoryTruth.rowCount
        || after.memoryTruth.logicalDigest !== before.memoryTruth.logicalDigest
        || canonicalMemoryItemsChanged !== 0
        || lifecycleRowsChanged !== 0
        || pendingOutboxRowsChanged !== 0)
        throw new Error("post-apply compatibility projection verification failed");
    return {
        schemaVersion: 1,
        phase: "clawlore-v2-live-compatibility-backfill",
        rolloutId: input.rolloutId,
        status: "applied",
        appliedAt,
        planDigest: input.planDigest,
        previewSha256: preview.sha256,
        source: {
            memoryTruthRows: after.memoryTruth.rowCount,
            memoryTruthLogicalDigest: after.memoryTruth.logicalDigest,
            unchanged: true,
        },
        projection: {
            objectName: "memory_fts_compat_v2",
            rows: projectionRows,
            expectedRows: livePlan.expectedProjectionRows,
            indexedLegacyMetadataFields: [...PHASE7G_LEGACY_SEARCH_FIELD_ALLOWLIST_V1],
            rawLegacyMetadataCopied: false,
            canonicalMemoryItemsChanged,
            lifecycleRowsChanged,
            pendingOutboxRowsChanged,
        },
        runtime: {
            v1FallbackReads: true,
            lifecycleMutationEnabled: false,
            contextEngineEnabled: false,
            promptMutationEnabled: false,
            finalRecallCutoverEnabled: false,
        },
    };
}
