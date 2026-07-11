/**
 * Controlled Experience promotion batches.
 *
 * Wraps the existing episode -> playbook promotion path with a stable batch ID,
 * reviewer note, dry-run-first default, and explicit backup guidance for
 * mutation runs.
 */

import { randomUUID } from "node:crypto";
import { promoteExperiences, type PromotionResult } from "./experience-promotion.js";
import { ensureExperienceSchema } from "./experience-store.js";

type DatabaseSync = any;

export interface PromotionBatchOptions {
  scope_id?: string;
  max_episodes?: number;
  dry_run?: boolean;
  reviewer_note?: string;
  requested_by?: string;
  record_preview?: boolean;
}

export interface PromotionBatchResult {
  dry_run: boolean;
  batch_id: string;
  status: "preview" | "applied" | "failed";
  recorded: boolean;
  scope_id?: string;
  reviewer_note: string;
  backup_required: boolean;
  backup_hint: string;
  promotion: PromotionResult;
}

const BACKUP_HINT =
  "Before --apply on a live store, back up the SQLite truth DB plus matching -wal/-shm files, then rerun doctor after the batch.";

export function ensurePromotionBatchSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experience_promotion_batches (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 1,
      reviewer_note TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT '',
      backup_hint TEXT NOT NULL DEFAULT '',
      promotion_summary TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      applied_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_experience_promotion_batches_scope
      ON experience_promotion_batches(scope_id);

    CREATE INDEX IF NOT EXISTS idx_experience_promotion_batches_status
      ON experience_promotion_batches(status);

    CREATE TABLE IF NOT EXISTS experience_promotion_batch_items (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      action TEXT NOT NULL,
      episode_id TEXT NOT NULL DEFAULT '',
      playbook_id TEXT NOT NULL DEFAULT '',
      risk_level TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_experience_promotion_batch_items_batch
      ON experience_promotion_batch_items(batch_id);
  `);
}

function compactPromotionSummary(promotion: PromotionResult): Record<string, unknown> {
  return {
    dry_run: promotion.dry_run,
    episodes_scanned: promotion.episodes_scanned,
    episodes_created: promotion.episodes_created,
    playbooks_created: promotion.playbooks_created,
    playbooks_promoted: promotion.playbooks_promoted,
    playbooks_needing_review: promotion.playbooks_needing_review,
    duplicates_skipped: promotion.duplicates_skipped,
    skipped: promotion.skipped,
    item_count: promotion.items.length,
  };
}

function insertBatch(
  db: DatabaseSync,
  params: {
    batchId: string;
    scopeId?: string;
    status: "preview" | "applied" | "failed";
    dryRun: boolean;
    reviewerNote: string;
    requestedBy: string;
    promotion: PromotionResult;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO experience_promotion_batches (
      id, scope_id, status, dry_run, reviewer_note, requested_by,
      backup_hint, promotion_summary, created_at, applied_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.batchId,
    params.scopeId ?? "",
    params.status,
    params.dryRun ? 1 : 0,
    params.reviewerNote,
    params.requestedBy,
    BACKUP_HINT,
    JSON.stringify(compactPromotionSummary(params.promotion)),
    now,
    params.status === "applied" ? now : null,
    JSON.stringify({ source: "experience_promotion_batch" }),
  );

  const insertItem = db.prepare(`
    INSERT INTO experience_promotion_batch_items (
      id, batch_id, action, episode_id, playbook_id, risk_level, status, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of params.promotion.items) {
    insertItem.run(
      randomUUID(),
      params.batchId,
      item.action,
      item.episode_id ?? "",
      item.playbook_id ?? "",
      item.risk_level ?? "",
      item.status ?? "",
      item.reason ?? "",
      now,
    );
  }
}

export function runPromotionBatch(
  db: DatabaseSync,
  options: PromotionBatchOptions = {},
): PromotionBatchResult {
  ensureExperienceSchema(db);

  const dryRun = options.dry_run ?? true;
  const batchId = randomUUID();
  const reviewerNote = String(options.reviewer_note ?? "").trim();
  const requestedBy = String(options.requested_by ?? "").trim();
  const promotion = promoteExperiences(db, {
    scope_id: options.scope_id,
    dry_run: dryRun,
    config: {
      max_episodes: Math.max(1, Math.min(Math.trunc(options.max_episodes ?? 50), 500)),
    },
  });

  const status = dryRun ? "preview" : "applied";
  const recorded = !dryRun || options.record_preview === true;
  if (recorded) {
    ensurePromotionBatchSchema(db);
    insertBatch(db, {
      batchId,
      scopeId: options.scope_id,
      status,
      dryRun,
      reviewerNote,
      requestedBy,
      promotion,
    });
  }

  return {
    dry_run: dryRun,
    batch_id: batchId,
    status,
    recorded,
    scope_id: options.scope_id,
    reviewer_note: reviewerNote,
    backup_required: !dryRun,
    backup_hint: BACKUP_HINT,
    promotion,
  };
}
