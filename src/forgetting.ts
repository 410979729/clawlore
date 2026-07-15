import { evaluateCaptureSafety, sanitizeCaptureText } from "./capture-safety.js";
import { diagnosticErrorSummary, diagnosticIdentifier } from "./diagnostic-redaction.js";

type DatabaseSync = any;

export interface ForgettingCandidate {
  id: string;
  scope: string;
  category: string;
  reason: string;
  preview: string;
  superseded_by?: string;
}

export interface ForgettingReport {
  total_rows: number;
  active_rows: number;
  soft_archive_candidates: {
    count: number;
    items: ForgettingCandidate[];
  };
  hard_delete_candidates: {
    count: number;
    items: ForgettingCandidate[];
  };
  duplicate_groups: {
    count: number;
    items: Array<{
      scope: string;
      category: string;
      key: string;
      keep_id: string;
      archive_ids: string[];
    }>;
  };
}

export interface ForgettingRunResult {
  dry_run: boolean;
  archived: number;
  deleted: number;
  archive_ids: string[];
  delete_ids: string[];
  vector_deleted?: number;
  vector_delete_errors?: string[];
  needs_repair?: boolean;
  hard_delete_blocked?: boolean;
  blocked_reason?: string;
}

type MemoryTruthRow = {
  id: string;
  text: string;
  category: string;
  scope: string;
  timestamp: number;
  metadata: string;
  updated_at: number;
};

function safeJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stableString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isArchived(row: MemoryTruthRow): boolean {
  const metadata = safeJsonObject(row.metadata);
  const state = stableString(metadata.state).toLowerCase();
  const layer = stableString(metadata.memory_layer).toLowerCase();
  const lifecycle = stableString(metadata.lifecycle).toLowerCase();
  return (
    state === "archived" ||
    state === "rejected" ||
    layer === "archive" ||
    ["archived", "obsolete", "rejected", "superseded"].includes(lifecycle)
  );
}

function normalizeDuplicateKey(row: MemoryTruthRow): string {
  const metadata = safeJsonObject(row.metadata);
  const factKey = stableString(metadata.fact_key).toLowerCase();
  if (factKey) return `fact:${factKey}`;
  const cleaned = sanitizeCaptureText(row.text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? `text:${cleaned}` : "";
}

function previewFor(row: MemoryTruthRow, reason: string, supersededBy = ""): ForgettingCandidate {
  const safety = evaluateCaptureSafety(row.text || "");
  const preview = safety.reason === "secret"
    ? "[redacted: secret-like content]"
    : sanitizeCaptureText(row.text || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const item: ForgettingCandidate = {
    id: row.id,
    scope: row.scope || "global",
    category: row.category || "other",
    reason,
    preview,
  };
  if (supersededBy) item.superseded_by = supersededBy;
  return item;
}

function addCandidate(
  target: Map<string, ForgettingCandidate>,
  row: MemoryTruthRow,
  reason: string,
  supersededBy = "",
): void {
  if (!target.has(row.id)) {
    target.set(row.id, previewFor(row, reason, supersededBy));
  }
}

function rowsForScopes(db: DatabaseSync, scopeFilter?: string[]): MemoryTruthRow[] {
  if (Array.isArray(scopeFilter) && scopeFilter.length === 0) return [];
  if (scopeFilter && scopeFilter.length > 0) {
    const placeholders = scopeFilter.map(() => "?").join(", ");
    return db.prepare(
      `SELECT id, text, category, scope, timestamp, metadata, updated_at
       FROM memory_truth
       WHERE scope IN (${placeholders})
       ORDER BY timestamp DESC, id ASC`,
    ).all(...scopeFilter) as MemoryTruthRow[];
  }
  return db.prepare(
    `SELECT id, text, category, scope, timestamp, metadata, updated_at
     FROM memory_truth
     ORDER BY timestamp DESC, id ASC`,
  ).all() as MemoryTruthRow[];
}

export function buildForgettingReport(
  db: DatabaseSync,
  options: { scopeFilter?: string[]; limit?: number } = {},
): ForgettingReport {
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 200)));
  const rows = rowsForScopes(db, options.scopeFilter);
  const activeRows = rows.filter((row) => !isArchived(row));
  const soft = new Map<string, ForgettingCandidate>();
  const hard = new Map<string, ForgettingCandidate>();
  const duplicateBuckets = new Map<string, MemoryTruthRow[]>();

  for (const row of activeRows) {
    const text = row.text || "";
    const metadata = safeJsonObject(row.metadata);
    const safety = evaluateCaptureSafety(text);
    if (!safety.allowed) {
      if (safety.reason === "secret") {
        addCandidate(hard, row, "secret-like-content");
      } else {
        addCandidate(soft, row, `capture-safety:${safety.reason || "blocked"}`);
      }
    }
    if (sanitizeCaptureText(text).trim().length <= 12) {
      addCandidate(soft, row, "very-short-low-value");
    }
    const source = stableString(metadata.source).toLowerCase();
    if (row.category === "other" && ["turn-assistant", "assistant", "session-summary"].includes(source)) {
      addCandidate(soft, row, "assistant-or-summary-scratch");
    }
    const key = normalizeDuplicateKey(row);
    if (key) {
      const groupKey = `${row.scope || "global"}\u0000${row.category || "other"}\u0000${key}`;
      const bucket = duplicateBuckets.get(groupKey) || [];
      bucket.push(row);
      duplicateBuckets.set(groupKey, bucket);
    }
  }

  const duplicateGroups: ForgettingReport["duplicate_groups"]["items"] = [];
  for (const [groupKey, groupRows] of duplicateBuckets.entries()) {
    if (groupRows.length <= 1) continue;
    const ordered = [...groupRows].sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || a.id.localeCompare(b.id));
    const keep = ordered[0];
    const archiveRows = ordered.slice(1);
    const [scope, category, key] = groupKey.split("\u0000");
    duplicateGroups.push({
      scope,
      category,
      key,
      keep_id: keep.id,
      archive_ids: archiveRows.map((row) => row.id),
    });
    for (const row of archiveRows) {
      addCandidate(soft, row, "duplicate-memory", keep.id);
    }
  }

  const softItems = [...soft.values()];
  const hardItems = [...hard.values()];
  return {
    total_rows: rows.length,
    active_rows: activeRows.length,
    soft_archive_candidates: {
      count: softItems.length,
      items: softItems.slice(0, limit),
    },
    hard_delete_candidates: {
      count: hardItems.length,
      items: hardItems.slice(0, limit),
    },
    duplicate_groups: {
      count: duplicateGroups.length,
      items: duplicateGroups.slice(0, limit),
    },
  };
}

function archiveMemory(db: DatabaseSync, id: string, reason: string, supersededBy = ""): boolean {
  const row = db.prepare("SELECT metadata FROM memory_truth WHERE id = ?").get(id) as { metadata?: string } | undefined;
  if (!row) return false;
  const metadata = safeJsonObject(row.metadata);
  if (stableString(metadata.state).toLowerCase() === "archived") return false;
  metadata.state = "archived";
  metadata.lifecycle = "archived";
  metadata.memory_layer = "archive";
  metadata.forget_reason = reason;
  metadata.archived_at = new Date().toISOString();
  if (supersededBy) metadata.superseded_by = supersededBy;
  db.prepare("UPDATE memory_truth SET metadata = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(metadata), Date.now(), id);
  return true;
}

function deleteMemory(db: DatabaseSync, id: string): boolean {
  const existing = db.prepare("SELECT 1 FROM memory_truth WHERE id = ?").get(id);
  if (!existing) return false;
  db.prepare("DELETE FROM memory_truth_fts WHERE memory_id = ?").run(id);
  db.prepare("DELETE FROM memory_truth WHERE id = ?").run(id);
  return true;
}

export function runForgetting(
  db: DatabaseSync,
  options: {
    scopeFilter?: string[];
    dryRun?: boolean;
    hardDeleteSensitive?: boolean;
    limit?: number;
  } = {},
): ForgettingRunResult {
  const dryRun = options.dryRun !== false;
  const report = buildForgettingReport(db, options);
  const softItems = report.soft_archive_candidates.items;
  const hardItems = options.hardDeleteSensitive === true ? report.hard_delete_candidates.items : [];
  const result: ForgettingRunResult = {
    dry_run: dryRun,
    archived: softItems.length,
    deleted: hardItems.length,
    archive_ids: softItems.map((item) => item.id),
    delete_ids: hardItems.map((item) => item.id),
  };
  if (dryRun) return result;

  db.exec("BEGIN IMMEDIATE");
  try {
    let archived = 0;
    let deleted = 0;
    for (const item of softItems) {
      if (archiveMemory(db, item.id, item.reason, item.superseded_by || "")) archived++;
    }
    for (const item of hardItems) {
      if (deleteMemory(db, item.id)) deleted++;
    }
    db.exec("COMMIT");
    result.archived = archived;
    result.deleted = deleted;
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

export async function runForgettingWithVectorSync(
  db: DatabaseSync,
  options: {
    scopeFilter?: string[];
    dryRun?: boolean;
    hardDeleteSensitive?: boolean;
    limit?: number;
    deleteVectorById?: (id: string, operation: string) => Promise<boolean>;
  } = {},
): Promise<ForgettingRunResult> {
  if (options.dryRun === false && options.hardDeleteSensitive === true && typeof options.deleteVectorById !== "function") {
    const report = buildForgettingReport(db, options);
    const softOnly = runForgetting(db, {
      ...options,
      hardDeleteSensitive: false,
    });
    return {
      ...softOnly,
      deleted: 0,
      delete_ids: report.hard_delete_candidates.items.map((item) => item.id),
      vector_deleted: 0,
      vector_delete_errors: report.hard_delete_candidates.items.map((item) => item.id),
      needs_repair: report.hard_delete_candidates.count > 0,
      hard_delete_blocked: report.hard_delete_candidates.count > 0,
      blocked_reason: report.hard_delete_candidates.count > 0
        ? "hard delete requires a vector companion delete callback"
        : undefined,
    };
  }

  if (options.dryRun === false && options.hardDeleteSensitive === true && typeof options.deleteVectorById === "function") {
    const report = buildForgettingReport(db, options);
    const hardDeleteIds = report.hard_delete_candidates.items.map((item) => item.id);
    if (hardDeleteIds.length > 0) {
      let vectorDeleted = 0;
      const vectorDeleteErrors: string[] = [];
      for (const id of hardDeleteIds) {
        try {
          const ok = await options.deleteVectorById(id, "forgetting-hard-delete-preflight");
          if (ok) {
            vectorDeleted++;
          } else {
            vectorDeleteErrors.push(id);
          }
        } catch (err) {
          vectorDeleteErrors.push(`${diagnosticIdentifier(id)}: ${diagnosticErrorSummary(err)}`);
        }
      }

      if (vectorDeleteErrors.length > 0) {
        const softOnly = runForgetting(db, {
          ...options,
          hardDeleteSensitive: false,
        });
        return {
          ...softOnly,
          deleted: 0,
          delete_ids: hardDeleteIds,
          vector_deleted: vectorDeleted,
          vector_delete_errors: vectorDeleteErrors,
          needs_repair: true,
          hard_delete_blocked: true,
          blocked_reason: "hard delete blocked because vector companion delete failed before SQL deletion",
        };
      }

      const result = runForgetting(db, options);
      result.vector_deleted = vectorDeleted;
      result.vector_delete_errors = [];
      result.needs_repair = false;
      return result;
    }
  }

  const result = runForgetting(db, options);
  if (result.dry_run || result.deleted === 0 || typeof options.deleteVectorById !== "function") {
    return result;
  }

  let vectorDeleted = 0;
  const vectorDeleteErrors: string[] = [];
  for (const id of result.delete_ids) {
    try {
      const ok = await options.deleteVectorById(id, "forgetting-hard-delete");
      if (ok) {
        vectorDeleted++;
      } else {
        vectorDeleteErrors.push(id);
      }
    } catch (err) {
      vectorDeleteErrors.push(`${diagnosticIdentifier(id)}: ${diagnosticErrorSummary(err)}`);
    }
  }

  result.vector_deleted = vectorDeleted;
  result.vector_delete_errors = vectorDeleteErrors;
  result.needs_repair = vectorDeleteErrors.length > 0;
  return result;
}
