import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { mapLegacyAddress } from "../application/legacy-address-mapper.js";
import { SqliteTruthStoreV2 } from "../storage/sqlite-truth-v2.js";
import { classifyLegacySourceV2 } from "./legacy-v2-preview.js";
const require = createRequire(import.meta.url);
function openLegacyReadOnly(path) {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(path, { readOnly: true });
}
function readLegacyRows(path) {
    const db = openLegacyReadOnly(path);
    try {
        const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_truth'").get();
        if (!exists)
            throw new Error("legacy memory_truth table not found");
        const columns = new Set(db.prepare("PRAGMA table_info(memory_truth)").all().map((row) => row.name));
        for (const required of ["id", "text", "category", "scope", "timestamp", "metadata"]) {
            if (!columns.has(required))
                throw new Error(`legacy memory_truth missing required column: ${required}`);
        }
        return db.prepare(`SELECT id,text,category,scope,timestamp,metadata
      FROM memory_truth ORDER BY id`).all().map((row) => ({
            id: String(row.id), text: String(row.text), category: String(row.category),
            scope: String(row.scope), timestamp: Number(row.timestamp), metadata: String(row.metadata || "{}"),
        }));
    }
    finally {
        db.close();
    }
}
function metadata(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function verificationFor(meta, classification) {
    const explicit = String(meta.verification ?? meta.verification_status ?? "").toLowerCase();
    if (["unverified", "user_confirmed", "tool_verified", "operator_reviewed", "disputed"].includes(explicit)) {
        return explicit;
    }
    return classification === "explicit_manual" ? "user_confirmed" : "unverified";
}
function lifecycleFor(meta, reviewRequired, verification) {
    const state = String(meta.state ?? meta.lifecycle ?? "").toLowerCase();
    if (["archived", "rejected", "superseded", "purged"].includes(state))
        return "archived";
    if (reviewRequired || verification === "unverified" || verification === "disputed")
        return "candidate";
    return "active";
}
function observedAt(row, meta) {
    const explicit = String(meta.observed_at ?? meta.observedAt ?? "");
    if (explicit && Number.isFinite(Date.parse(explicit)))
        return new Date(explicit).toISOString();
    if (Number.isFinite(row.timestamp) && row.timestamp > 0) {
        return new Date(row.timestamp > 1_000_000_000_000 ? row.timestamp : row.timestamp * 1000).toISOString();
    }
    return new Date(0).toISOString();
}
function planRows(input) {
    return readLegacyRows(input.legacyPath).map((row) => {
        const meta = metadata(row.metadata);
        const mapping = mapLegacyAddress({ id: row.id, scope: row.scope, metadata: meta }, input.defaults);
        const classification = classifyLegacySourceV2(meta);
        const verification = verificationFor(meta, classification);
        const lifecycle = lifecycleFor(meta, mapping.reviewRequired, verification);
        return {
            source: row,
            plan: {
                legacyId: row.id,
                contentHash: createHash("sha256").update(row.text).digest("hex"),
                classification,
                lifecycle,
                verification,
                reviewRequired: mapping.reviewRequired,
                verificationDebt: mapping.verificationDebt,
            },
        };
    });
}
function publicPlan(rows) {
    const publicRows = rows.map((row) => row.plan);
    const planDigest = createHash("sha256").update(JSON.stringify(publicRows)).digest("hex");
    return {
        schemaVersion: 2,
        readOnly: true,
        planDigest,
        totalRows: rows.length,
        activeRows: publicRows.filter((row) => row.lifecycle === "active").length,
        candidateRows: publicRows.filter((row) => row.lifecycle === "candidate").length,
        archivedRows: publicRows.filter((row) => row.lifecycle === "archived").length,
        rows: publicRows,
    };
}
export function planLegacyMigrationV2(input) {
    return publicPlan(planRows(input));
}
export function buildLegacyMigrationBatchV2(input) {
    const rows = planRows(input);
    return {
        plan: publicPlan(rows),
        rows: rows.map(({ source, plan }) => {
            const meta = metadata(source.metadata);
            const mapping = mapLegacyAddress({ id: source.id, scope: source.scope, metadata: meta }, input.defaults);
            return {
                legacyId: source.id,
                content: source.text,
                category: source.category || "other",
                address: mapping.address,
                lifecycle: plan.lifecycle,
                verification: plan.verification,
                observedAt: observedAt(source, meta),
                classification: plan.classification,
                reviewRequired: plan.reviewRequired,
                verificationDebt: plan.verificationDebt,
            };
        }),
    };
}
export async function applyLegacyMigrationV2(input) {
    if (input.approved !== true)
        throw new Error("migration apply requires explicit approval");
    if (existsSync(input.destinationPath))
        throw new Error("migration destination already exists");
    const rows = planRows(input);
    const plan = publicPlan(rows);
    if (plan.planDigest !== input.expectedPlanDigest)
        throw new Error("migration plan digest mismatch");
    const store = new SqliteTruthStoreV2(input.destinationPath);
    const markerPath = `${input.destinationPath}.clawlore-migration.json`;
    const migrationId = input.id?.() ?? randomUUID();
    const appliedAt = (input.now?.() ?? new Date()).toISOString();
    try {
        store.open();
        for (const { source, plan: row } of rows) {
            const meta = metadata(source.metadata);
            const mapping = mapLegacyAddress({ id: source.id, scope: source.scope, metadata: meta }, input.defaults);
            store.remember({
                itemId: `legacy:${source.id}`,
                content: source.text,
                category: source.category || "other",
                address: mapping.address,
                lifecycle: row.lifecycle,
                verification: row.verification,
                source: {
                    sourceType: "legacy",
                    sourceId: source.id,
                    observedAt: observedAt(source, meta),
                    evidence: {
                        classification: row.classification,
                        legacyScope: source.scope,
                        reviewRequired: row.reviewRequired,
                        verificationDebt: row.verificationDebt,
                    },
                },
                actor: "operator:migration",
                reason: "legacy_v2_migration_apply",
            });
        }
        store.close();
        await writeFile(markerPath, `${JSON.stringify({
            schemaVersion: 1,
            migrationId,
            planDigest: plan.planDigest,
            rowsApplied: rows.length,
            appliedAt,
        }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return { schemaVersion: 2, migrationId, planDigest: plan.planDigest, rowsApplied: rows.length, markerPath, appliedAt };
    }
    catch (error) {
        store.close();
        await Promise.all([
            rm(input.destinationPath, { force: true }),
            rm(`${input.destinationPath}-wal`, { force: true }),
            rm(`${input.destinationPath}-shm`, { force: true }),
            rm(markerPath, { force: true }),
        ]);
        throw error;
    }
}
export async function rollbackLegacyMigrationV2(input) {
    const markerPath = `${input.destinationPath}.clawlore-migration.json`;
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker.migrationId !== input.migrationId || marker.planDigest !== input.planDigest) {
        throw new Error("migration rollback marker mismatch");
    }
    await Promise.all([
        rm(input.destinationPath, { force: true }),
        rm(`${input.destinationPath}-wal`, { force: true }),
        rm(`${input.destinationPath}-shm`, { force: true }),
        rm(markerPath, { force: true }),
    ]);
    return { schemaVersion: 2, rolledBack: true, migrationId: input.migrationId };
}
