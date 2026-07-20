/**
 * Auto-recall trace ledger.
 *
 * Stores compact, redacted metadata about automatic recall decisions. The
 * ledger is deliberately not a transcript archive: it records counts, scope
 * decisions, hashed memory references, and filter reasons without memory text.
 */
import { createHash, randomUUID } from "node:crypto";
import { redactSupportBundle } from "./application/support-bundle.js";
import { redactKnownSecrets } from "./secret-redaction.js";
const TRACE_TABLE = "auto_recall_trace_events";
const WRAPPER_PATTERNS = [
    /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi,
    /\[UNTRUSTED DATA[\s\S]*?\[END UNTRUSTED DATA\]/gi,
    /tool call:\s*\w+/gi,
    /\[toolResult\][\s\S]*/gi,
];
function tableExists(db, name) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = ?").get(name);
    return row?.name === name;
}
function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    const n = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}
function redactText(value, maxChars = 220) {
    let text = String(value ?? "");
    for (const pattern of WRAPPER_PATTERNS) {
        pattern.lastIndex = 0;
        text = text.replace(pattern, "[redacted: wrapper]");
    }
    text = redactKnownSecrets(text).replace(/\s+/g, " ").trim();
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
function memoryRef(value) {
    const raw = String(value ?? "").trim();
    if (!raw)
        return "mem_unknown";
    const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    return `mem_${digest}`;
}
function querySummary(value) {
    const raw = String(value ?? "");
    if (!raw)
        return "";
    const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    return `sha256:${digest};length=${raw.length}`;
}
function normalizeScore(value) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(6)) : undefined;
}
function normalizeReason(reason) {
    return redactText(reason, 120);
}
function parseJson(value, fallback) {
    if (typeof value !== "string" || !value.trim())
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function countBy(items) {
    const counts = {};
    for (const item of items) {
        const key = item || "";
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
export function ensureAutoRecallLedgerSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS auto_recall_trace_events (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      query_source TEXT NOT NULL DEFAULT '',
      query_preview TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      result_count INTEGER NOT NULL DEFAULT 0,
      injected_count INTEGER NOT NULL DEFAULT 0,
      suppressed_count INTEGER NOT NULL DEFAULT 0,
      crossed_scope_count INTEGER NOT NULL DEFAULT 0,
      filter_reasons TEXT NOT NULL DEFAULT '{}',
      memory_refs TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auto_recall_trace_scope
      ON auto_recall_trace_events(scope_id);

    CREATE INDEX IF NOT EXISTS idx_auto_recall_trace_decision
      ON auto_recall_trace_events(decision);

    CREATE INDEX IF NOT EXISTS idx_auto_recall_trace_created
      ON auto_recall_trace_events(created_at);
  `);
}
export function normalizeAutoRecallMemoryRefs(refs = [], currentScope = "") {
    return refs.slice(0, 50).map((ref) => {
        const scope = String(ref.scope ?? "").trim();
        const filterStatus = ref.filter_status ?? "candidate";
        return {
            memory_ref: memoryRef(ref.memory_id),
            scope,
            category: String(ref.category ?? "").trim(),
            score: normalizeScore(ref.score),
            rank_reasons: Array.isArray(ref.rank_reasons)
                ? ref.rank_reasons.slice(0, 6).map((reason) => redactText(reason, 120))
                : [],
            filter_status: filterStatus,
            filter_reason: normalizeReason(ref.filter_reason ?? ""),
            crossed_scope: Boolean(currentScope && scope && scope !== currentScope && scope !== "global"),
        };
    });
}
export function recordAutoRecallTrace(db, params) {
    ensureAutoRecallLedgerSchema(db);
    const id = randomUUID();
    const createdAt = params.created_at ?? new Date().toISOString();
    const memoryRefs = normalizeAutoRecallMemoryRefs(params.memory_refs ?? [], params.current_scope ?? params.scope_id);
    const filterReasons = countBy(memoryRefs
        .filter((ref) => ref.filter_status !== "candidate" && ref.filter_status !== "injected")
        .map((ref) => ref.filter_reason || ref.filter_status));
    const crossedScopeCount = memoryRefs.filter((ref) => ref.crossed_scope).length;
    db.prepare(`
    INSERT INTO auto_recall_trace_events (
      id, scope_id, session_id, agent_id, channel, query_source, query_preview,
      decision, reason, result_count, injected_count, suppressed_count,
      crossed_scope_count, filter_reasons, memory_refs, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.scope_id, params.session_id ?? "", params.agent_id ?? "", params.channel ?? "", redactText(params.query_source ?? "", 80), params.include_query_preview === true
        ? redactText(params.query ?? "", 260)
        : querySummary(params.query), params.decision, normalizeReason(params.reason ?? ""), clampInt(params.result_count, memoryRefs.length, 0, 10_000), clampInt(params.injected_count, memoryRefs.filter((ref) => ref.filter_status === "injected").length, 0, 10_000), clampInt(params.suppressed_count, memoryRefs.filter((ref) => ref.filter_status !== "injected").length, 0, 10_000), crossedScopeCount, JSON.stringify(filterReasons), JSON.stringify(memoryRefs), JSON.stringify(redactSupportBundle(params.metadata ?? {})), createdAt);
    return id;
}
export function listAutoRecallTraces(db, options = {}) {
    const generatedAt = new Date().toISOString();
    if (!tableExists(db, TRACE_TABLE)) {
        return {
            status: "schema_missing",
            generated_at: generatedAt,
            scope_id: options.scope_id,
            total: 0,
            totals: { decisions: {}, filter_reasons: {}, crossed_scope: 0 },
            items: [],
            missing_tables: [TRACE_TABLE],
        };
    }
    const limit = clampInt(options.limit, 20, 1, 500);
    const where = options.scope_id ? "WHERE scope_id = ?" : "";
    const params = options.scope_id ? [options.scope_id, limit] : [limit];
    const rows = db.prepare(`
    SELECT * FROM auto_recall_trace_events
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params);
    const countParams = options.scope_id ? [options.scope_id] : [];
    const totalRow = db.prepare(`
    SELECT COUNT(*) AS count FROM auto_recall_trace_events ${where}
  `).get(...countParams);
    const decisionRows = db.prepare(`
    SELECT decision AS key, COUNT(*) AS count FROM auto_recall_trace_events
    ${where}
    GROUP BY decision
  `).all(...countParams);
    const items = rows.map((row) => {
        const memoryRefs = parseJson(row.memory_refs, []);
        return {
            id: String(row.id ?? ""),
            scope_id: String(row.scope_id ?? ""),
            session_id: String(row.session_id ?? ""),
            agent_id: String(row.agent_id ?? ""),
            channel: String(row.channel ?? ""),
            query_source: String(row.query_source ?? ""),
            query_preview: String(row.query_preview ?? ""),
            decision: String(row.decision ?? "skipped"),
            reason: String(row.reason ?? ""),
            result_count: Number(row.result_count ?? 0),
            injected_count: Number(row.injected_count ?? 0),
            suppressed_count: Number(row.suppressed_count ?? 0),
            crossed_scope_count: Number(row.crossed_scope_count ?? 0),
            filter_reasons: parseJson(row.filter_reasons, {}),
            memory_refs: memoryRefs,
            created_at: String(row.created_at ?? ""),
            metadata: parseJson(row.metadata, {}),
        };
    });
    const filterReasonCounts = {};
    for (const item of items) {
        for (const [reason, count] of Object.entries(item.filter_reasons)) {
            filterReasonCounts[reason] = (filterReasonCounts[reason] ?? 0) + count;
        }
    }
    return {
        status: "ok",
        generated_at: generatedAt,
        scope_id: options.scope_id,
        total: Number(totalRow?.count ?? 0),
        totals: {
            decisions: Object.fromEntries(decisionRows
                .map((row) => [String(row.key ?? ""), Number(row.count ?? 0)])
                .sort(([a], [b]) => a.localeCompare(b))),
            filter_reasons: Object.fromEntries(Object.entries(filterReasonCounts).sort(([a], [b]) => a.localeCompare(b))),
            crossed_scope: items.reduce((sum, item) => sum + item.crossed_scope_count, 0),
        },
        items,
    };
}
