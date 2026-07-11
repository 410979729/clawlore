import { randomUUID } from "node:crypto";
import { ensureGovernanceAuditSchema } from "./governance-cleanup.js";
const REQUIRED_TABLES = ["journal_entries", "journal_rejections", "memory_journal_sources"];
function tableNames(db) {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all();
    return new Set(rows.map((row) => String(row.name)));
}
function missingTables(db) {
    const tables = tableNames(db);
    return REQUIRED_TABLES.filter((name) => !tables.has(name));
}
function normalizePrefixes(prefixes) {
    const cleaned = (prefixes || ["retry-exhausted:"])
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    return cleaned.length > 0 ? cleaned : ["retry-exhausted:"];
}
function counts(items, key) {
    const result = {};
    for (const item of items) {
        const value = String(item[key] || "");
        result[value] = (result[value] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
function findReplayCandidates(db, options = {}) {
    const prefixes = normalizePrefixes(options.reasonPrefixes);
    const clauses = prefixes.map(() => "r.reason LIKE ?").join(" OR ");
    const params = prefixes.map((prefix) => `${prefix}%`);
    const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 500)));
    const rows = db.prepare(`
    SELECT
      e.id AS journal_entry_id,
      e.scope_id,
      e.session_id,
      e.turn_number,
      e.role,
      e.processed_run_id,
      e.processed_at,
      e.created_at,
      r.run_id,
      r.reason
    FROM journal_rejections AS r
    JOIN journal_entries AS e ON e.id = r.journal_entry_id
    LEFT JOIN memory_journal_sources AS s ON s.journal_entry_id = e.id
    WHERE (${clauses})
      AND COALESCE(e.processed_run_id, '') != ''
      AND r.run_id = e.processed_run_id
      AND s.memory_id IS NULL
    ORDER BY r.created_at DESC, e.id ASC
    LIMIT ?
  `).all(...params, limit * 10);
    const seen = new Set();
    const items = [];
    for (const row of rows) {
        const id = Number(row.journal_entry_id || 0);
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        items.push({
            journal_entry_id: id,
            scope: String(row.scope_id || ""),
            session_id: String(row.session_id || ""),
            turn_number: Number(row.turn_number || 0),
            role: String(row.role || ""),
            processed_run_id: String(row.processed_run_id || ""),
            processed_at: String(row.processed_at || ""),
            run_id: String(row.run_id || ""),
            reason: String(row.reason || ""),
            created_at: String(row.created_at || ""),
        });
        if (items.length >= limit)
            break;
    }
    return items;
}
export function recoveryReport(db, options = {}) {
    const prefixes = normalizePrefixes(options.reasonPrefixes);
    const missing = missingTables(db);
    if (missing.length > 0) {
        return {
            status: "unsupported",
            candidate_count: 0,
            reason_prefixes: prefixes,
            missing_tables: missing,
            by_reason: {},
            by_scope: {},
            items: [],
        };
    }
    const items = findReplayCandidates(db, options);
    return {
        status: "ready",
        candidate_count: items.length,
        reason_prefixes: prefixes,
        by_reason: counts(items, "reason"),
        by_scope: counts(items, "scope"),
        items,
    };
}
export function scheduleReplay(db, options = {}) {
    const dryRun = options.dryRun !== false;
    const batchId = options.batchId || `journal-recovery-${randomUUID()}`;
    const report = recoveryReport(db, options);
    const result = {
        ...report,
        dry_run: dryRun,
        batch_id: batchId,
        scheduled: 0,
        entry_ids: report.items.map((item) => item.journal_entry_id),
    };
    if (report.status === "unsupported" || dryRun || report.items.length === 0)
        return result;
    ensureGovernanceAuditSchema(db);
    db.exec("BEGIN IMMEDIATE");
    try {
        let scheduled = 0;
        for (const item of report.items) {
            const current = db.prepare("SELECT id, processed_run_id, processed_at FROM journal_entries WHERE id = ?").get(item.journal_entry_id);
            if (!current || String(current.processed_run_id || "") !== item.run_id)
                continue;
            db.prepare("UPDATE journal_entries SET processed_run_id = '', processed_at = NULL WHERE id = ?")
                .run(item.journal_entry_id);
            db.prepare("DELETE FROM journal_rejections WHERE journal_entry_id = ? AND run_id = ?")
                .run(item.journal_entry_id, item.run_id);
            db.prepare(`
        INSERT INTO governance_audit_events (
          id, event_type, action, scope_id, target_id, batch_id,
          before_json, after_json, reason, actor, dry_run, created_at
        ) VALUES (?, 'journal_recovery', 'schedule_replay', ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(`gov_${randomUUID()}`, item.scope, String(item.journal_entry_id), batchId, JSON.stringify(item), JSON.stringify({ journal_entry_id: item.journal_entry_id, processed_run_id: "", processed_at: null }), item.reason, options.actor || "journal-recovery", new Date().toISOString());
            scheduled++;
        }
        db.exec("COMMIT");
        result.scheduled = scheduled;
        return result;
    }
    catch (err) {
        try {
            db.exec("ROLLBACK");
        }
        catch { }
        throw err;
    }
}
