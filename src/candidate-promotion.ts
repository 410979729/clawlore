import { randomUUID } from "node:crypto";
import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { isNoise } from "./noise-filter.js";
import { ensureGovernanceAuditSchema } from "./governance-cleanup.js";

type DatabaseSync = any;

type MemoryTruthRow = {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
  updated_at: number;
};

export type CandidatePromotionAction = "promote" | "archive" | "keep_candidate" | "skip";

export interface CandidatePromotionDecision {
  action: CandidatePromotionAction;
  reason: string;
  confidence: number;
  importance: number;
  memory_type: string;
  risk: "low" | "high";
}

export interface CandidatePromotionReviewItem {
  id: string;
  scope: string;
  category: string;
  decision: CandidatePromotionAction;
  effective_action: CandidatePromotionAction;
  reason: string;
  risk: "low" | "high";
  confidence: number;
  importance: number;
  memory_type: string;
  updated_at: number;
  preview: string;
}

const STABLE_MEMORY_TYPES = new Set([
  "case",
  "cases",
  "constraint",
  "decision",
  "entity",
  "entities",
  "event",
  "events",
  "fact",
  "factual",
  "pitfall",
  "preference",
  "preferences",
  "procedure",
  "profile",
  "project",
  "resource",
  "workflow",
]);

const NOISE_MEMORY_TYPES = new Set([
  "summary",
  "episodic",
  "tool_trace",
  "scratch",
]);

const REVIEW_TERMS = [
  "password",
  "token",
  "secret",
  "api key",
  "api_id",
  "api_hash",
  "credential",
  "private key",
  "sudo",
  "systemctl",
  "delete",
  "restart",
  "commit",
  "push",
  "tag",
  "release",
  "密钥",
  "密码",
  "凭据",
  "删除",
  "重启",
  "发布",
  "推送",
  "提交",
];

const STALE_PROGRESS_TERMS = [
  "commit ",
  "commit `",
  "pull request",
  "pr #",
  "run `",
  "pid ",
  "工作树",
  "已推送",
  "已发布",
  "当前仍为",
];

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function jsonStable(value: unknown): string {
  const replacer = (_key: string, item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  };
  return JSON.stringify(value, replacer);
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function metadataNumber(metadata: Record<string, unknown>, key: string, fallback: number): number {
  const raw = metadata[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function containsAny(text: string, terms: string[]): boolean {
  const lowered = text.toLowerCase();
  return terms.some((term) => lowered.includes(term.toLowerCase()));
}

function previewFor(text: string): string {
  const safety = evaluateCaptureSafety(text || "");
  if (safety.reason === "secret") return "[redacted: secret-like content]";
  return sanitizeCaptureText(text || "")
    .replace(/\/home\/[^\s"',;)}\]]+/g, "[redacted:path]")
    .replace(/\/Users\/[^\s"',;)}\]]+/g, "[redacted:path]")
    .replace(/[A-Z]:\\[^\s"',;)}\]]+/g, "[redacted:path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function candidateText(row: MemoryTruthRow, metadata: Record<string, unknown>): string {
  return [
    row.text,
    metadataString(metadata, "l0_abstract"),
    metadataString(metadata, "l1_overview"),
    metadataString(metadata, "l2_content"),
  ].filter(Boolean).join("\n");
}

function isCandidateRow(row: MemoryTruthRow): boolean {
  const metadata = safeJsonObject(row.metadata);
  const lifecycle = metadataString(metadata, "lifecycle").toLowerCase();
  const state = metadataString(metadata, "state").toLowerCase();
  return lifecycle === "candidate" || state === "pending";
}

function candidateWhereClause(): string {
  return `
    (
      LOWER(COALESCE(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.lifecycle') ELSE '' END, '')) = 'candidate'
      OR LOWER(COALESCE(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.state') ELSE '' END, '')) = 'pending'
    )
  `;
}

export function candidateRows(db: DatabaseSync, options: { limit?: number } = {}): MemoryTruthRow[] {
  const limit = Math.max(1, Math.min(5000, Math.trunc(options.limit ?? 1000)));
  return db.prepare(`
    SELECT id, text, category, scope, importance, timestamp, metadata, updated_at
    FROM memory_truth
    WHERE ${candidateWhereClause()}
    ORDER BY updated_at ASC, timestamp ASC, id ASC
    LIMIT ?
  `).all(limit) as MemoryTruthRow[];
}

export function classifyCandidateRow(row: MemoryTruthRow): CandidatePromotionDecision {
  const metadata = safeJsonObject(row.metadata);
  if (!isCandidateRow(row)) {
    return {
      action: "skip",
      reason: "not_candidate",
      confidence: metadataNumber(metadata, "confidence", 0),
      importance: Number(row.importance || 0),
      memory_type: metadataString(metadata, "memory_category") || row.category || "other",
      risk: "low",
    };
  }

  const confidence = metadataNumber(metadata, "confidence", 0.7);
  const importance = Number.isFinite(Number(row.importance))
    ? Number(row.importance)
    : metadataNumber(metadata, "importance", 0.7);
  const memoryType = (
    metadataString(metadata, "memory_type") ||
    metadataString(metadata, "memory_category") ||
    row.category ||
    "other"
  ).toLowerCase();
  const text = candidateText(row, metadata);
  const safety = evaluateCaptureSafety(text);

  if (!safety.allowed || safety.reason === "secret") {
    return {
      action: "keep_candidate",
      reason: `requires_human_review:${safety.reason || "unsafe"}`,
      confidence,
      importance,
      memory_type: memoryType,
      risk: "high",
    };
  }
  if (containsAny(text, REVIEW_TERMS)) {
    return {
      action: "keep_candidate",
      reason: "high_risk_terms_require_human_review",
      confidence,
      importance,
      memory_type: memoryType,
      risk: "high",
    };
  }
  if (NOISE_MEMORY_TYPES.has(memoryType) || isNoise(text) || sanitizeCaptureText(text).trim().length < 20) {
    return {
      action: "archive",
      reason: `low_value_memory_type:${memoryType || "unknown"}`,
      confidence,
      importance,
      memory_type: memoryType,
      risk: "low",
    };
  }
  if (containsAny(text, STALE_PROGRESS_TERMS) && ["summary", "decision", "project", "events"].includes(memoryType)) {
    return {
      action: "archive",
      reason: "stale_progress_or_release_status",
      confidence,
      importance,
      memory_type: memoryType,
      risk: "low",
    };
  }
  if (!STABLE_MEMORY_TYPES.has(memoryType)) {
    return {
      action: "keep_candidate",
      reason: `unsupported_memory_type:${memoryType || "unknown"}`,
      confidence,
      importance,
      memory_type: memoryType,
      risk: "low",
    };
  }
  if (confidence >= 0.78 && importance >= 0.55) {
    return {
      action: "promote",
      reason: "high_confidence_stable_candidate",
      confidence,
      importance,
      memory_type: memoryType,
      risk: "low",
    };
  }
  if (importance >= 0.82 && confidence >= 0.62) {
    return {
      action: "promote",
      reason: "high_importance_stable_candidate",
      confidence,
      importance,
      memory_type: memoryType,
      risk: "low",
    };
  }
  return {
    action: "keep_candidate",
    reason: "below_auto_promotion_threshold",
    confidence,
    importance,
    memory_type: memoryType,
    risk: "low",
  };
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = ?").get(table);
  return Boolean(row);
}

function summarizeRows(rows: MemoryTruthRow[], sampleLimit: number): Record<string, unknown> {
  const byAction: Record<string, number> = { promote: 0, archive: 0, keep_candidate: 0, skip: 0 };
  const byScope: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const samples: CandidatePromotionReviewItem[] = [];
  let oldestUpdatedAt = 0;
  let newestUpdatedAt = 0;

  for (const row of rows) {
    const metadata = safeJsonObject(row.metadata);
    const decision = classifyCandidateRow(row);
    byAction[decision.action] = (byAction[decision.action] || 0) + 1;
    byScope[row.scope || ""] = (byScope[row.scope || ""] || 0) + 1;
    const source = metadataString(metadata, "source") || "unknown";
    bySource[source] = (bySource[source] || 0) + 1;
    const updatedAt = Number(row.updated_at || row.timestamp || 0);
    if (!oldestUpdatedAt || (updatedAt && updatedAt < oldestUpdatedAt)) oldestUpdatedAt = updatedAt;
    if (!newestUpdatedAt || updatedAt > newestUpdatedAt) newestUpdatedAt = updatedAt;
    if (samples.length < sampleLimit) {
      samples.push({
        id: row.id,
        scope: row.scope || "global",
        category: row.category || "other",
        decision: decision.action,
        effective_action: decision.action,
        reason: decision.reason,
        risk: decision.risk,
        confidence: decision.confidence,
        importance: decision.importance,
        memory_type: decision.memory_type,
        updated_at: updatedAt,
        preview: previewFor(candidateText(row, metadata) || row.text),
      });
    }
  }

  const oldestAgeHours = oldestUpdatedAt
    ? Math.round(((Date.now() - oldestUpdatedAt) / 36_000)) / 100
    : 0;

  return {
    candidate_count: rows.length,
    oldest_updated_at: oldestUpdatedAt,
    newest_updated_at: newestUpdatedAt,
    oldest_age_hours: oldestAgeHours,
    by_action: byAction,
    by_scope: Object.fromEntries(Object.entries(byScope).sort(([a], [b]) => a.localeCompare(b))),
    by_source: Object.fromEntries(Object.entries(bySource).sort(([a], [b]) => a.localeCompare(b))),
    samples,
  };
}

export function candidateDebtReport(
  db: DatabaseSync,
  options: { limit?: number; sampleLimit?: number } = {},
): Record<string, unknown> {
  if (!tableExists(db, "memory_truth")) {
    return { status: "unsupported", candidate_count: 0, reason: "memory_truth table is missing" };
  }
  const limit = Math.max(1, Math.min(5000, Math.trunc(options.limit ?? 1000)));
  const rows = candidateRows(db, { limit });
  return {
    status: rows.length > 0 ? "debt" : "ready",
    ...summarizeRows(rows, Math.max(0, Math.min(25, Math.trunc(options.sampleLimit ?? 8)))),
    limit,
    truncated: rows.length >= limit,
  };
}

function auditSnapshot(row: MemoryTruthRow, metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    category: row.category,
    importance: row.importance,
    timestamp: row.timestamp,
    updated_at: row.updated_at,
    metadata,
  };
}

function metadataAfter(
  metadata: Record<string, unknown>,
  params: { action: "promote" | "archive"; reason: string; batchId: string; actor: string; at: string },
): Record<string, unknown> {
  const next = { ...metadata };
  if (params.action === "promote") {
    next.lifecycle = "promoted";
    next.state = "confirmed";
    next.promoted_at = params.at;
    next.promoted_by = params.actor;
    next.promotion_reason = params.reason;
    next.candidate_promotion_batch_id = params.batchId;
  } else {
    next.lifecycle = "archived";
    next.state = "archived";
    next.memory_layer = "archive";
    next.archived_at = params.at;
    next.archived_by = params.actor;
    next.archive_reason = params.reason;
    next.candidate_promotion_batch_id = params.batchId;
  }
  return next;
}

function recordAuditEvent(
  db: DatabaseSync,
  params: {
    action: "promote" | "archive";
    row: MemoryTruthRow;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    reason: string;
    batchId: string;
    actor: string;
    at: string;
  },
): void {
  db.prepare(`
    INSERT INTO governance_audit_events (
      id, event_type, action, scope_id, target_id, batch_id,
      before_json, after_json, reason, actor, dry_run, created_at
    ) VALUES (?, 'memory_candidate_promotion', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    `gov_${randomUUID()}`,
    params.action,
    params.row.scope || "",
    params.row.id,
    params.batchId,
    jsonStable(auditSnapshot(params.row, params.before)),
    jsonStable(auditSnapshot(params.row, params.after)),
    params.reason,
    params.actor,
    params.at,
  );
}

export function promoteMemoryCandidates(
  db: DatabaseSync,
  options: {
    dryRun?: boolean;
    archiveNoise?: boolean;
    limit?: number;
    batchId?: string;
    actor?: string;
  } = {},
): Record<string, unknown> {
  if (!tableExists(db, "memory_truth")) {
    return { ok: false, status: "unsupported", dry_run: options.dryRun !== false, error: "memory_truth table is missing" };
  }

  const dryRun = options.dryRun !== false;
  const limit = Math.max(1, Math.min(5000, Math.trunc(options.limit ?? 1000)));
  const batchId = options.batchId || `candidate-promotion-${randomUUID()}`;
  const actor = options.actor || "scope-recall-openclaw";
  const at = nowIso();
  const before = candidateDebtReport(db, { limit });
  const rows = candidateRows(db, { limit });
  const reviewed: CandidatePromotionReviewItem[] = [];
  const mutations = { promoted: 0, archived: 0, kept: 0, skipped: 0 };

  if (!dryRun) ensureGovernanceAuditSchema(db);

  for (const row of rows) {
    const metadata = safeJsonObject(row.metadata);
    const decision = classifyCandidateRow(row);
    const effectiveAction =
      decision.action === "archive" && !options.archiveNoise
        ? "keep_candidate"
        : decision.action;
    reviewed.push({
      id: row.id,
      scope: row.scope || "global",
      category: row.category || "other",
      decision: decision.action,
      effective_action: effectiveAction,
      reason: decision.reason,
      risk: decision.risk,
      confidence: decision.confidence,
      importance: decision.importance,
      memory_type: decision.memory_type,
      updated_at: Number(row.updated_at || row.timestamp || 0),
      preview: previewFor(candidateText(row, metadata) || row.text),
    });

    if (effectiveAction === "promote") mutations.promoted += 1;
    else if (effectiveAction === "archive") mutations.archived += 1;
    else if (effectiveAction === "skip") mutations.skipped += 1;
    else mutations.kept += 1;

    if (dryRun || (effectiveAction !== "promote" && effectiveAction !== "archive")) continue;
    const after = metadataAfter(metadata, {
      action: effectiveAction,
      reason: decision.reason,
      batchId,
      actor,
      at,
    });
    db.prepare(`
      UPDATE memory_truth
      SET metadata = ?, updated_at = ?
      WHERE id = ? AND ${candidateWhereClause()}
    `).run(jsonStable(after), Date.now(), row.id);
    recordAuditEvent(db, {
      action: effectiveAction,
      row,
      before: metadata,
      after,
      reason: decision.reason,
      batchId,
      actor,
      at,
    });
  }

  const after = candidateDebtReport(db, { limit });
  return {
    ok: true,
    status: dryRun ? "dry_run" : "applied",
    dry_run: dryRun,
    batch_id: batchId,
    archive_noise: options.archiveNoise === true,
    before,
    mutations,
    after,
    reviewed,
  };
}
