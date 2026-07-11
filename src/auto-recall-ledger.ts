/**
 * Auto-recall trace ledger.
 *
 * Stores compact, redacted metadata about automatic recall decisions. The
 * ledger is deliberately not a transcript archive: it records counts, scope
 * decisions, hashed memory references, and filter reasons without memory text.
 */

import { createHash, randomUUID } from "node:crypto";

type DatabaseSync = any;

export type AutoRecallDecision = "injected" | "skipped" | "failed";

export type AutoRecallFilterStatus =
  | "candidate"
  | "dedup_filtered"
  | "governance_filtered"
  | "budget_filtered"
  | "injected"
  | "suppressed";

export interface AutoRecallMemoryRefInput {
  memory_id?: string;
  scope?: string;
  category?: string;
  score?: number;
  rank_reasons?: string[];
  filter_status?: AutoRecallFilterStatus;
  filter_reason?: string;
}

export interface AutoRecallMemoryRef {
  memory_ref: string;
  scope: string;
  category: string;
  score?: number;
  rank_reasons: string[];
  filter_status: AutoRecallFilterStatus;
  filter_reason: string;
  crossed_scope: boolean;
}

export interface RecordAutoRecallTraceParams {
  scope_id: string;
  session_id?: string;
  agent_id?: string;
  channel?: string;
  query_source?: string;
  query?: string;
  decision: AutoRecallDecision;
  reason?: string;
  result_count?: number;
  injected_count?: number;
  suppressed_count?: number;
  memory_refs?: AutoRecallMemoryRefInput[];
  current_scope?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface AutoRecallTraceItem {
  id: string;
  scope_id: string;
  session_id: string;
  agent_id: string;
  channel: string;
  query_source: string;
  query_preview: string;
  decision: AutoRecallDecision;
  reason: string;
  result_count: number;
  injected_count: number;
  suppressed_count: number;
  crossed_scope_count: number;
  filter_reasons: Record<string, number>;
  memory_refs: AutoRecallMemoryRef[];
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface AutoRecallTraceReport {
  status: "ok" | "schema_missing";
  generated_at: string;
  scope_id?: string;
  total: number;
  totals: {
    decisions: Record<string, number>;
    filter_reasons: Record<string, number>;
    crossed_scope: number;
  };
  items: AutoRecallTraceItem[];
  missing_tables?: string[];
}

const TRACE_TABLE = "auto_recall_trace_events";

const SECRET_LIKE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:api[_-]?key|token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*["']?[^"'\s,;]{4,}/gi,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];

const WRAPPER_PATTERNS = [
  /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi,
  /\[UNTRUSTED DATA[\s\S]*?\[END UNTRUSTED DATA\]/gi,
  /tool call:\s*\w+/gi,
  /\[toolResult\][\s\S]*/gi,
];

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = ?",
  ).get(name) as { name?: string } | undefined;
  return row?.name === name;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const n = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function redactText(value: unknown, maxChars = 220): string {
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  for (const pattern of WRAPPER_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[redacted: wrapper]");
  }
  for (const pattern of SECRET_LIKE_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[redacted: secret-like content]");
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function memoryRef(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "mem_unknown";
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `mem_${digest}`;
}

function normalizeScore(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(6)) : undefined;
}

function normalizeReason(reason: unknown): string {
  return redactText(reason, 120);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function countBy(items: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item || "";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function ensureAutoRecallLedgerSchema(db: DatabaseSync): void {
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

export function normalizeAutoRecallMemoryRefs(
  refs: AutoRecallMemoryRefInput[] = [],
  currentScope = "",
): AutoRecallMemoryRef[] {
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

export function recordAutoRecallTrace(
  db: DatabaseSync,
  params: RecordAutoRecallTraceParams,
): string {
  ensureAutoRecallLedgerSchema(db);
  const id = randomUUID();
  const createdAt = params.created_at ?? new Date().toISOString();
  const memoryRefs = normalizeAutoRecallMemoryRefs(params.memory_refs ?? [], params.current_scope ?? params.scope_id);
  const filterReasons = countBy(
    memoryRefs
      .filter((ref) => ref.filter_status !== "candidate" && ref.filter_status !== "injected")
      .map((ref) => ref.filter_reason || ref.filter_status),
  );
  const crossedScopeCount = memoryRefs.filter((ref) => ref.crossed_scope).length;

  db.prepare(`
    INSERT INTO auto_recall_trace_events (
      id, scope_id, session_id, agent_id, channel, query_source, query_preview,
      decision, reason, result_count, injected_count, suppressed_count,
      crossed_scope_count, filter_reasons, memory_refs, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.scope_id,
    params.session_id ?? "",
    params.agent_id ?? "",
    params.channel ?? "",
    params.query_source ?? "",
    redactText(params.query ?? "", 260),
    params.decision,
    normalizeReason(params.reason ?? ""),
    clampInt(params.result_count, memoryRefs.length, 0, 10_000),
    clampInt(params.injected_count, memoryRefs.filter((ref) => ref.filter_status === "injected").length, 0, 10_000),
    clampInt(params.suppressed_count, memoryRefs.filter((ref) => ref.filter_status !== "injected").length, 0, 10_000),
    crossedScopeCount,
    JSON.stringify(filterReasons),
    JSON.stringify(memoryRefs),
    JSON.stringify(params.metadata ?? {}),
    createdAt,
  );

  return id;
}

export function listAutoRecallTraces(
  db: DatabaseSync,
  options: { scope_id?: string; limit?: number } = {},
): AutoRecallTraceReport {
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
  `).all(...params) as Array<Record<string, unknown>>;

  const countParams = options.scope_id ? [options.scope_id] : [];
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count FROM auto_recall_trace_events ${where}
  `).get(...countParams) as { count?: number } | undefined;

  const decisionRows = db.prepare(`
    SELECT decision AS key, COUNT(*) AS count FROM auto_recall_trace_events
    ${where}
    GROUP BY decision
  `).all(...countParams) as Array<{ key: string; count: number }>;

  const items = rows.map((row) => {
    const memoryRefs = parseJson<AutoRecallMemoryRef[]>(row.memory_refs, []);
    return {
      id: String(row.id ?? ""),
      scope_id: String(row.scope_id ?? ""),
      session_id: String(row.session_id ?? ""),
      agent_id: String(row.agent_id ?? ""),
      channel: String(row.channel ?? ""),
      query_source: String(row.query_source ?? ""),
      query_preview: String(row.query_preview ?? ""),
      decision: String(row.decision ?? "skipped") as AutoRecallDecision,
      reason: String(row.reason ?? ""),
      result_count: Number(row.result_count ?? 0),
      injected_count: Number(row.injected_count ?? 0),
      suppressed_count: Number(row.suppressed_count ?? 0),
      crossed_scope_count: Number(row.crossed_scope_count ?? 0),
      filter_reasons: parseJson<Record<string, number>>(row.filter_reasons, {}),
      memory_refs: memoryRefs,
      created_at: String(row.created_at ?? ""),
      metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    };
  });

  const filterReasonCounts: Record<string, number> = {};
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
      decisions: Object.fromEntries(
        decisionRows
          .map((row) => [String(row.key ?? ""), Number(row.count ?? 0)] as const)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      filter_reasons: Object.fromEntries(
        Object.entries(filterReasonCounts).sort(([a], [b]) => a.localeCompare(b)),
      ),
      crossed_scope: items.reduce((sum, item) => sum + item.crossed_scope_count, 0),
    },
    items,
  };
}
