import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function scalar(db, sql) {
    return Number(Object.values(db.prepare(sql).get())[0] ?? 0);
}
function hasTables(db, names) {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN (${names.map(() => "?").join(",")})`).all(...names);
    return new Set(rows.map((row) => String(row.name))).size === names.length;
}
export function inspectRuntimeV2CutoverPreflightV1(sqlitePath) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000;");
        const required = [
            "memory_truth",
            "memory_items",
            "memory_sources",
            "memory_fts_v2",
            "projection_outbox",
        ];
        if (!hasTables(db, required)) {
            return {
                schemaVersion: 1,
                readOnly: true,
                cutoverReady: false,
                v1RetirementReady: false,
                blockers: ["v2_schema_missing"],
                counts: {
                    v1: 0, v2: 0, active: 0, activeVerified: 0, candidate: 0,
                    unresolvedPrincipal: 0, unmirroredV1: 0, pendingOutbox: 0,
                    currentFts: 0, expectedCurrentFts: 0, contentDivergence: 0,
                    foreignKeyViolations: 0,
                },
                integrity: "not_checked",
            };
        }
        const counts = {
            v1: scalar(db, "SELECT COUNT(*) FROM memory_truth"),
            v2: scalar(db, "SELECT COUNT(*) FROM memory_items"),
            active: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle='active'"),
            activeVerified: scalar(db, `SELECT COUNT(*) FROM memory_items
        WHERE lifecycle='active' AND verification IN ('user_confirmed','tool_verified','operator_reviewed')`),
            candidate: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle IN ('observed','candidate')"),
            unresolvedPrincipal: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE principal_id='legacy:unresolved'"),
            unmirroredV1: scalar(db, `SELECT COUNT(*) FROM memory_truth l WHERE NOT EXISTS (
        SELECT 1 FROM memory_sources s JOIN memory_revisions r ON r.revision_id=s.revision_id
        WHERE s.source_type IN ('legacy','tool') AND s.external_id=l.id
      )`),
            pendingOutbox: scalar(db, "SELECT COUNT(*) FROM projection_outbox WHERE processed_at IS NULL"),
            currentFts: scalar(db, "SELECT COUNT(*) FROM memory_fts_v2"),
            expectedCurrentFts: scalar(db, "SELECT COUNT(*) FROM memory_items WHERE lifecycle NOT IN ('archived','purged')"),
            contentDivergence: scalar(db, `SELECT COUNT(*) FROM memory_items i
        JOIN memory_sources s ON s.revision_id=i.current_revision_id AND s.source_type='legacy'
        JOIN memory_truth l ON l.id=s.external_id WHERE i.content<>l.text`),
            foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all().length,
        };
        const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0] ?? "unknown");
        const blockers = [];
        if (integrity !== "ok")
            blockers.push("database_integrity_failed");
        if (counts.foreignKeyViolations !== 0)
            blockers.push("foreign_key_violation");
        if (counts.unmirroredV1 !== 0)
            blockers.push("v1_rows_unmirrored");
        if (counts.unresolvedPrincipal !== 0)
            blockers.push("legacy_principal_unresolved");
        if (counts.activeVerified === 0)
            blockers.push("active_verified_memory_empty");
        if (counts.pendingOutbox !== 0)
            blockers.push("pending_projection_outbox");
        if (counts.currentFts !== counts.expectedCurrentFts)
            blockers.push("current_fts_projection_mismatch");
        if (counts.contentDivergence !== 0)
            blockers.push("current_content_divergence");
        const cutoverBlockers = new Set(blockers);
        const cutoverReady = cutoverBlockers.size === 0;
        if (counts.candidate !== 0)
            blockers.push("undisposed_candidate_memory");
        return {
            schemaVersion: 1,
            readOnly: true,
            cutoverReady,
            v1RetirementReady: cutoverReady && counts.candidate === 0 && counts.v1 === counts.v2,
            blockers,
            counts,
            integrity,
        };
    }
    finally {
        db.close();
    }
}
