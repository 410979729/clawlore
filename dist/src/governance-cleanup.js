import { randomUUID } from "node:crypto";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
export const TEMPLATE_NOISE_REASONS = [
    "template.operations-workflow-summary",
    "template.journal-digest-memory",
    "transcript.role-prefix-user",
    "transcript.role-prefix-assistant",
];
function nowIso() {
    return new Date().toISOString();
}
function safeJsonObject(raw) {
    if (!raw)
        return {};
    if (typeof raw === "object" && !Array.isArray(raw))
        return raw;
    try {
        const parsed = JSON.parse(String(raw));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function jsonStable(value) {
    return JSON.stringify(value, Object.keys(value).sort());
}
function isArchived(row) {
    const metadata = safeJsonObject(row.metadata);
    const state = String(metadata.state || "").toLowerCase();
    const layer = String(metadata.memory_layer || "").toLowerCase();
    const lifecycle = String(metadata.lifecycle || "").toLowerCase();
    return state === "archived" || layer === "archive" || lifecycle === "archived";
}
export function ensureGovernanceAuditSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS governance_audit_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      scope_id TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      batch_id TEXT NOT NULL DEFAULT '',
      before_json TEXT NOT NULL DEFAULT '{}',
      after_json TEXT NOT NULL DEFAULT '{}',
      reason TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'scope-recall-openclaw',
      dry_run INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_governance_audit_batch
      ON governance_audit_events(batch_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_governance_audit_target
      ON governance_audit_events(target_id, created_at);
  `);
}
export function classifyCleanupReason(text) {
    const lowered = sanitizeCaptureText(text || "").toLowerCase().trimStart();
    if (lowered.startsWith("operations workflow summary from journal digest:") || lowered.startsWith("operations workflow summary")) {
        return "template.operations-workflow-summary";
    }
    if (lowered.startsWith("journal digest memory")) {
        return "template.journal-digest-memory";
    }
    if (/(?:^|[\s。；;])user:\s*/.test(lowered)) {
        return "transcript.role-prefix-user";
    }
    if (/(?:^|[\s。；;])assistant:\s*/.test(lowered)) {
        return "transcript.role-prefix-assistant";
    }
    return "";
}
function rowsForScopes(db, scopeFilter) {
    if (Array.isArray(scopeFilter) && scopeFilter.length === 0)
        return [];
    if (scopeFilter && scopeFilter.length > 0) {
        const placeholders = scopeFilter.map(() => "?").join(", ");
        return db.prepare(`
      SELECT id, text, category, scope, importance, timestamp, metadata, updated_at
      FROM memory_truth
      WHERE scope IN (${placeholders})
      ORDER BY updated_at DESC, id ASC
    `).all(...scopeFilter);
    }
    return db.prepare(`
    SELECT id, text, category, scope, importance, timestamp, metadata, updated_at
    FROM memory_truth
    ORDER BY updated_at DESC, id ASC
  `).all();
}
function previewFor(text) {
    const safety = evaluateCaptureSafety(text || "");
    if (safety.reason === "secret")
        return "[redacted: secret-like content]";
    return sanitizeCaptureText(text || "").replace(/\s+/g, " ").trim().slice(0, 180);
}
export function activeDirtyCounts(db, options = {}) {
    const counts = Object.fromEntries(TEMPLATE_NOISE_REASONS.map((reason) => [reason, 0]));
    for (const row of rowsForScopes(db, options.scopeFilter)) {
        if (isArchived(row))
            continue;
        const reason = classifyCleanupReason(row.text);
        if (reason)
            counts[reason] = (counts[reason] || 0) + 1;
    }
    return counts;
}
export function findCleanupCandidates(db, options = {}) {
    const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 500)));
    const candidates = [];
    for (const row of rowsForScopes(db, options.scopeFilter)) {
        if (!options.includeArchived && isArchived(row))
            continue;
        const reason = classifyCleanupReason(row.text);
        if (!reason)
            continue;
        candidates.push({
            id: row.id,
            scope: row.scope || "global",
            category: row.category || "other",
            reason,
            updated_at: Number(row.updated_at || 0),
            preview: previewFor(row.text),
        });
        if (candidates.length >= limit)
            break;
    }
    return candidates;
}
function snapshot(row) {
    return {
        id: row.id,
        scope: row.scope,
        category: row.category,
        importance: row.importance,
        timestamp: row.timestamp,
        updated_at: row.updated_at,
        metadata: safeJsonObject(row.metadata),
    };
}
function reasonCounts(items) {
    const counts = {};
    for (const item of items)
        counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
}
function recordAuditEvent(db, params) {
    db.prepare(`
    INSERT INTO governance_audit_events (
      id, event_type, action, scope_id, target_id, batch_id,
      before_json, after_json, reason, actor, dry_run, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(`gov_${randomUUID()}`, params.eventType, params.action, params.scope, params.targetId, params.batchId, JSON.stringify(params.before), JSON.stringify(params.after), params.reason, params.actor, nowIso());
}
export function applyCleanup(db, options = {}) {
    const dryRun = options.dryRun !== false;
    if (!dryRun)
        ensureGovernanceAuditSchema(db);
    const batchId = options.batchId || `cleanup-${randomUUID()}`;
    const items = findCleanupCandidates(db, {
        scopeFilter: options.scopeFilter,
        includeArchived: false,
        limit: options.limit,
    });
    const result = {
        dry_run: dryRun,
        batch_id: batchId,
        candidate_count: items.length,
        archived: 0,
        archive_ids: items.map((item) => item.id),
        reason_counts: reasonCounts(items),
        items,
    };
    if (dryRun || items.length === 0)
        return result;
    const actor = options.actor || "governance-cleanup";
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
        let archived = 0;
        for (const item of items) {
            const row = db.prepare(`
        SELECT id, text, category, scope, importance, timestamp, metadata, updated_at
        FROM memory_truth WHERE id = ?
      `).get(item.id);
            if (!row || isArchived(row))
                continue;
            const before = snapshot(row);
            const metadata = safeJsonObject(row.metadata);
            metadata.state = "archived";
            metadata.lifecycle = "archived";
            metadata.memory_layer = "archive";
            metadata.cleanup_reason = item.reason;
            metadata.archived_at = nowIso();
            metadata.archived_by = actor;
            metadata.rollback_batch_id = batchId;
            db.prepare("UPDATE memory_truth SET metadata = ?, updated_at = ? WHERE id = ?")
                .run(JSON.stringify(metadata), now, item.id);
            const after = { ...before, updated_at: now, metadata };
            recordAuditEvent(db, {
                eventType: "memory_cleanup",
                action: "soft_archive",
                scope: item.scope,
                targetId: item.id,
                batchId,
                before,
                after,
                reason: item.reason,
                actor,
            });
            archived++;
        }
        db.exec("COMMIT");
        result.archived = archived;
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
export function rollbackCleanupBatch(db, options) {
    ensureGovernanceAuditSchema(db);
    const dryRun = options.dryRun !== false;
    const rows = db.prepare(`
    SELECT target_id, scope_id, before_json, after_json, reason
    FROM governance_audit_events
    WHERE batch_id = ? AND event_type = 'memory_cleanup' AND action = 'soft_archive' AND dry_run = 0
    ORDER BY created_at ASC, id ASC
  `).all(options.batchId);
    const restoreIds = rows.map((row) => String(row.target_id || ""));
    const result = {
        dry_run: dryRun,
        batch_id: options.batchId,
        rollback_candidates: rows.length,
        restored: 0,
        restore_ids: restoreIds,
    };
    if (dryRun || rows.length === 0)
        return result;
    const actor = options.actor || "governance-cleanup";
    db.exec("BEGIN IMMEDIATE");
    try {
        let restored = 0;
        for (const audit of rows) {
            const id = String(audit.target_id || "");
            const before = safeJsonObject(audit.before_json);
            const beforeMetadata = safeJsonObject(before.metadata);
            const current = db.prepare("SELECT id, metadata FROM memory_truth WHERE id = ?").get(id);
            if (!current)
                continue;
            const currentMetadata = safeJsonObject(current.metadata);
            if (String(currentMetadata.rollback_batch_id || "") !== options.batchId)
                continue;
            db.prepare("UPDATE memory_truth SET metadata = ?, updated_at = ? WHERE id = ?")
                .run(jsonStable(beforeMetadata), Date.now(), id);
            recordAuditEvent(db, {
                eventType: "memory_cleanup",
                action: "rollback_soft_archive",
                scope: String(audit.scope_id || ""),
                targetId: id,
                batchId: options.batchId,
                before: { id, metadata: currentMetadata },
                after: { id, metadata: beforeMetadata },
                reason: String(audit.reason || "rollback"),
                actor,
            });
            restored++;
        }
        db.exec("COMMIT");
        result.restored = restored;
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
