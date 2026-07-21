import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { enforcePrivatePath, ensurePrivateDirectory } from "../../file-privacy.js";
import type {
  ClaimProjectionOutboxV2Input,
  CorrectMemoryV2Input,
  ForgetMemoryV2Input,
  ProjectionOutboxClaimV2,
  ProjectionOutboxRowV2,
  RememberMemoryV2Input,
  TruthStoreV2Port,
} from "../application/ports/truth-store.js";
import type {
  MemoryCenterEventRowV1,
  MemoryCenterProjectionHealthV1,
  MemoryCenterReadPortV1,
  MemoryCenterRelationRowV1,
  MemoryCenterRowV1,
} from "../application/ports/memory-center-read.js";
import type { MemoryAddressV2 } from "../domain/memory-address.js";
import { validateMemoryAddress } from "../domain/memory-address.js";
import {
  assertMemoryAddressIdentifiersSafe,
  normalizeInitialLifecycle,
  normalizeIsoTimestamp,
  normalizeMemorySource,
  normalizeOptionalIsoTimestamp,
  normalizeTruthIdentifier,
  normalizeTruthSemanticText,
  normalizeVerification,
} from "../domain/truth-write-policy.js";
import type {
  MemoryLifecycleV2,
  MemoryMutationReceiptV2,
  MemoryRecordV2,
  MemorySourceV2,
  MemoryVerificationV2,
} from "../domain/memory-record.js";

const PROJECTIONS = ["fts", "vector", "relations"] as const;

function enforcePrivateSqliteFamily(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) enforcePrivatePath(candidate, { kind: "file" });
  }
}

export const TRUTH_V2_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS clawlore_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_item_identities (
    item_id TEXT PRIMARY KEY,created_at TEXT NOT NULL,purged_at TEXT
  );
  CREATE TABLE IF NOT EXISTS memory_items (
    item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
    content TEXT NOT NULL,category TEXT NOT NULL,address_json TEXT NOT NULL,
    tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,agent_id TEXT NOT NULL,
    visibility TEXT NOT NULL,retention TEXT NOT NULL,workspace_id TEXT,project_id TEXT,
    conversation_id TEXT,thread_id TEXT,customer_id TEXT,task_id TEXT,
    lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    FOREIGN KEY(item_id) REFERENCES memory_item_identities(item_id) ON DELETE RESTRICT,
    FOREIGN KEY(item_id,current_revision_id) REFERENCES memory_revisions(item_id,revision_id)
      DEFERRABLE INITIALLY DEFERRED
  );
  CREATE TABLE IF NOT EXISTS memory_revisions (
    revision_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
    content TEXT NOT NULL,lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,
    created_at TEXT NOT NULL,UNIQUE(item_id,revision_no),UNIQUE(item_id,revision_id),
    FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
      DEFERRABLE INITIALLY DEFERRED
  );
  CREATE TABLE IF NOT EXISTS memory_sources (
    source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,source_type TEXT NOT NULL,
    external_id TEXT,observed_at TEXT NOT NULL,evidence_json TEXT NOT NULL,
    FOREIGN KEY(revision_id) REFERENCES memory_revisions(revision_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS memory_acl (
    acl_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,
    visibility TEXT NOT NULL,policy_json TEXT NOT NULL,created_at TEXT NOT NULL,
    FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS memory_relations (
    relation_id TEXT PRIMARY KEY,from_revision_id TEXT NOT NULL,to_revision_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,created_at TEXT NOT NULL,
    FOREIGN KEY(from_revision_id) REFERENCES memory_revisions(revision_id) ON DELETE CASCADE,
    FOREIGN KEY(to_revision_id) REFERENCES memory_revisions(revision_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS memory_events (
    event_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_id TEXT,event_type TEXT NOT NULL,
    actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,
    FOREIGN KEY(item_id) REFERENCES memory_item_identities(item_id) ON DELETE RESTRICT,
    FOREIGN KEY(revision_id) REFERENCES memory_revisions(revision_id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS projection_outbox (
    outbox_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_id TEXT,operation TEXT NOT NULL,
    projection TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL,
    created_at TEXT NOT NULL,processed_at TEXT,last_error TEXT,
    FOREIGN KEY(item_id) REFERENCES memory_item_identities(item_id) ON DELETE RESTRICT,
    FOREIGN KEY(revision_id) REFERENCES memory_revisions(revision_id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS projection_outbox_claims (
    outbox_id TEXT PRIMARY KEY,claim_token TEXT NOT NULL UNIQUE,claim_owner TEXT NOT NULL,
    claimed_at TEXT NOT NULL,lease_expires_at TEXT NOT NULL,
    FOREIGN KEY(outbox_id) REFERENCES projection_outbox(outbox_id) ON DELETE CASCADE
  );
  CREATE TRIGGER IF NOT EXISTS memory_items_identity_before_insert
  BEFORE INSERT ON memory_items
  BEGIN
    INSERT OR IGNORE INTO memory_item_identities(item_id,created_at,purged_at)
    VALUES (NEW.item_id,NEW.created_at,NULL);
  END;
  CREATE INDEX IF NOT EXISTS idx_memory_access ON memory_items
    (tenant_id,principal_id,agent_id,visibility,lifecycle,verification);
  CREATE INDEX IF NOT EXISTS idx_memory_conversation ON memory_items
    (tenant_id,conversation_id,thread_id,lifecycle);
  CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_items
    (tenant_id,project_id,customer_id,lifecycle);
  CREATE INDEX IF NOT EXISTS idx_outbox_pending ON projection_outbox
    (processed_at,available_at,projection);
  CREATE INDEX IF NOT EXISTS idx_outbox_item_projection_pending ON projection_outbox
    (item_id,projection,processed_at);
  CREATE INDEX IF NOT EXISTS idx_outbox_claim_expiry ON projection_outbox_claims
    (lease_expires_at,outbox_id);
  INSERT OR IGNORE INTO clawlore_schema(version,applied_at) VALUES (3,datetime('now'));
`;

export type {
  ClaimProjectionOutboxV2Input,
  CorrectMemoryV2Input,
  ForgetMemoryV2Input,
  ProjectionOutboxClaimV2,
  ProjectionOutboxRowV2,
  RememberMemoryV2Input,
} from "../application/ports/truth-store.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface TruthStoreClock {
  now(): Date;
  id(): string;
}

const DEFAULT_CLOCK: TruthStoreClock = {
  now: () => new Date(),
  id: () => randomUUID(),
};

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseAddress(row: Record<string, unknown>): MemoryAddressV2 {
  return JSON.parse(String(row.address_json)) as MemoryAddressV2;
}

function toRecord(row: Record<string, unknown>): MemoryRecordV2 {
  return {
    itemId: String(row.item_id),
    revisionId: String(row.current_revision_id),
    revision: Number(row.revision_no),
    content: String(row.content),
    category: String(row.category),
    address: parseAddress(row),
    lifecycle: row.lifecycle as MemoryLifecycleV2,
    verification: row.verification as MemoryVerificationV2,
    validUntil: row.valid_until ? String(row.valid_until) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteTruthStoreV2 implements TruthStoreV2Port, MemoryCenterReadPortV1 {
  private db: DatabaseSync | null = null;

  constructor(
    private readonly sqlitePath: string,
    private readonly clock: TruthStoreClock = DEFAULT_CLOCK,
  ) {}

  open(): void {
    if (this.db) return;
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    ensurePrivateDirectory(dirname(this.sqlitePath));
    enforcePrivateSqliteFamily(this.sqlitePath);
    this.db = new DatabaseSync(this.sqlitePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.ensureSchema();
    enforcePrivateSqliteFamily(this.sqlitePath);
  }

  close(): void {
    this.db?.close?.();
    this.db = null;
    enforcePrivateSqliteFamily(this.sqlitePath);
  }

  remember(input: RememberMemoryV2Input): MemoryMutationReceiptV2 {
    this.assertAddress(input.address);
    const content = normalizeTruthSemanticText(input.content, "memory content", 64_000, { collapseWhitespace: false });
    const category = normalizeTruthIdentifier(input.category, "memory category", 256);
    const actor = normalizeTruthIdentifier(input.actor, "memory actor", 512);
    const reason = normalizeTruthSemanticText(input.reason, "memory reason", 4_000);
    const lifecycle = normalizeInitialLifecycle(input.lifecycle);
    const verification = normalizeVerification(input.verification);
    const validUntil = normalizeOptionalIsoTimestamp(input.validUntil, "memory validUntil");
    const source = normalizeMemorySource(input.source);
    const db = this.requireDb();
    const now = this.clock.now().toISOString();
    const itemId = input.itemId == null
      ? this.clock.id()
      : normalizeTruthIdentifier(input.itemId, "memory item id", 512);
    const revisionId = this.clock.id();
    const eventId = this.clock.id();
    const outboxIds = [this.clock.id(), this.clock.id(), this.clock.id()];
    this.transaction(() => {
      db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        revisionId, itemId, 1, content, lifecycle,
        verification, validUntil ?? null, now,
      );
      db.prepare(`INSERT INTO memory_items
        (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
         visibility,retention,workspace_id,project_id,conversation_id,thread_id,customer_id,task_id,
         lifecycle,verification,valid_until,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        itemId, revisionId, 1, content, category, json(input.address),
        input.address.tenantId, input.address.principalId, input.address.agentId,
        input.address.visibility, input.address.retention, input.address.workspaceId ?? null,
        input.address.projectId ?? null, input.address.conversationId ?? null,
        input.address.threadId ?? null, input.address.customerId ?? null, input.address.taskId ?? null,
        lifecycle, verification, validUntil ?? null, now, now,
      );
      this.insertSource(revisionId, source);
      db.prepare(`INSERT INTO memory_acl (acl_id,item_id,owner_principal_id,visibility,policy_json,created_at)
        VALUES (?,?,?,?,?,?)`).run(this.clock.id(), itemId, input.address.principalId, input.address.visibility, "{}", now);
      this.insertEvent(eventId, itemId, revisionId, "remembered", actor, reason, now);
      this.insertOutbox(outboxIds, itemId, revisionId, "upsert", now);
    });
    return {
      schemaVersion: 2, action: "remember", itemId, revisionId, eventId, outboxIds,
      projection: { schemaVersion: 1, status: "pending", operation: "upsert", expected: [...PROJECTIONS], outboxIds },
      committedAt: now,
    };
  }

  correct(input: CorrectMemoryV2Input): MemoryMutationReceiptV2 {
    const itemId = normalizeTruthIdentifier(input.itemId, "memory item id", 512);
    const content = normalizeTruthSemanticText(input.content, "memory content", 64_000, { collapseWhitespace: false });
    const actor = normalizeTruthIdentifier(input.actor, "memory actor", 512);
    const reason = normalizeTruthSemanticText(input.reason, "memory reason", 4_000);
    const source = normalizeMemorySource(input.source);
    const db = this.requireDb();
    const current = this.get(itemId);
    if (!current) throw new Error("memory item not found");
    if (["archived", "superseded", "purged"].includes(current.lifecycle)) {
      throw new Error(`memory correction requires an explicit restore from lifecycle ${current.lifecycle}`);
    }
    const nextLifecycle = current.lifecycle;
    const verification = normalizeVerification(input.verification, current.verification);
    const validUntil = input.validUntil == null
      ? current.validUntil
      : normalizeOptionalIsoTimestamp(input.validUntil, "memory validUntil");
    const now = this.clock.now().toISOString();
    const revisionId = this.clock.id();
    const eventId = this.clock.id();
    const outboxIds = [this.clock.id(), this.clock.id(), this.clock.id()];
    this.transaction(() => {
      db.prepare("UPDATE memory_revisions SET lifecycle='superseded' WHERE revision_id=?")
        .run(current.revisionId);
      db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        revisionId, current.itemId, current.revision + 1, content, nextLifecycle,
        verification, validUntil ?? null, now,
      );
      db.prepare(`UPDATE memory_items SET current_revision_id=?,revision_no=?,content=?,lifecycle=?,
        verification=?,valid_until=?,updated_at=? WHERE item_id=?`).run(
        revisionId, current.revision + 1, content, nextLifecycle, verification,
        validUntil ?? null, now, current.itemId,
      );
      this.insertSource(revisionId, source);
      db.prepare(`INSERT INTO memory_relations
        (relation_id,from_revision_id,to_revision_id,relation_type,created_at)
        VALUES (?,?,?,?,?)`).run(this.clock.id(), revisionId, current.revisionId, "supersedes", now);
      this.insertEvent(eventId, current.itemId, revisionId, "corrected", actor, reason, now);
      this.insertOutbox(outboxIds, current.itemId, revisionId, "upsert", now);
    });
    return {
      schemaVersion: 2, action: "correct", itemId: current.itemId, revisionId,
      previousRevisionId: current.revisionId, eventId, outboxIds,
      projection: { schemaVersion: 1, status: "pending", operation: "upsert", expected: [...PROJECTIONS], outboxIds },
      committedAt: now,
    };
  }

  forget(input: ForgetMemoryV2Input): MemoryMutationReceiptV2 {
    const itemId = normalizeTruthIdentifier(input.itemId, "memory item id", 512);
    const actor = normalizeTruthIdentifier(input.actor, "memory actor", 512);
    const reason = normalizeTruthSemanticText(input.reason, "memory reason", 4_000);
    if (input.hardDelete != null && typeof input.hardDelete !== "boolean") {
      throw new Error("hard delete flag must be boolean");
    }
    if (input.approved != null && typeof input.approved !== "boolean") {
      throw new Error("hard delete approval flag must be boolean");
    }
    if (input.hardDelete && input.approved !== true) throw new Error("hard delete requires explicit approval");
    const db = this.requireDb();
    const current = this.get(itemId);
    if (!current) throw new Error("memory item not found");
    const now = this.clock.now().toISOString();
    const eventId = this.clock.id();
    const operation = input.hardDelete ? "purge" : "delete";
    const outboxIds = [this.clock.id(), this.clock.id(), this.clock.id()];
    let revisionId: string | undefined;
    this.transaction(() => {
      if (input.hardDelete) {
        db.prepare("DELETE FROM memory_sources WHERE revision_id IN (SELECT revision_id FROM memory_revisions WHERE item_id=?)").run(current.itemId);
        db.prepare("DELETE FROM memory_relations WHERE from_revision_id IN (SELECT revision_id FROM memory_revisions WHERE item_id=?) OR to_revision_id IN (SELECT revision_id FROM memory_revisions WHERE item_id=?)").run(current.itemId, current.itemId);
        db.prepare("DELETE FROM memory_acl WHERE item_id=?").run(current.itemId);
        db.prepare("DELETE FROM memory_revisions WHERE item_id=?").run(current.itemId);
        db.prepare("DELETE FROM memory_items WHERE item_id=?").run(current.itemId);
        db.prepare("UPDATE memory_item_identities SET purged_at=? WHERE item_id=?").run(now, current.itemId);
      } else {
        revisionId = this.clock.id();
        db.prepare("UPDATE memory_revisions SET lifecycle='superseded' WHERE revision_id=?").run(current.revisionId);
        db.prepare(`INSERT INTO memory_revisions
          (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(
          revisionId, current.itemId, current.revision + 1, current.content, "archived",
          current.verification, current.validUntil ?? null, now,
        );
        db.prepare(`UPDATE memory_items SET current_revision_id=?,revision_no=?,lifecycle='archived',updated_at=?
          WHERE item_id=?`).run(revisionId, current.revision + 1, now, current.itemId);
      }
      this.insertEvent(eventId, current.itemId, revisionId, input.hardDelete ? "purged" : "archived", actor, reason, now);
      this.insertOutbox(outboxIds, current.itemId, revisionId, operation, now);
    });
    return {
      schemaVersion: 2, action: input.hardDelete ? "purge" : "archive",
      itemId: current.itemId, revisionId, previousRevisionId: current.revisionId,
      eventId, outboxIds,
      projection: { schemaVersion: 1, status: "pending", operation, expected: [...PROJECTIONS], outboxIds },
      committedAt: now,
    };
  }

  get(itemId: string): MemoryRecordV2 | null {
    const row = this.requireDb().prepare("SELECT * FROM memory_items WHERE item_id=? LIMIT 1").get(itemId);
    return row ? toRecord(row as Record<string, unknown>) : null;
  }

  queryAccessible(actor: MemoryAddressV2, query: string, limit = 20): MemoryRecordV2[] {
    const needle = query.trim();
    if (!needle) return [];
    const validation = validateMemoryAddress(actor);
    if (!validation.valid) return [];
    const escaped = needle.replace(/[\\%_]/g, (value) => `\\${value}`);
    const rows = this.requireDb().prepare(`SELECT * FROM memory_items
      WHERE tenant_id=? AND agent_id=? AND lifecycle='active'
        AND (valid_until IS NULL OR valid_until >= ?)
        AND content LIKE ? ESCAPE '\\'
        AND (
          (visibility='private' AND principal_id=?)
          OR (visibility='conversation' AND conversation_id=? AND (thread_id IS NULL OR thread_id=?))
          OR (visibility='project' AND project_id=?)
        )
      ORDER BY updated_at DESC,item_id ASC LIMIT ?`).all(
      actor.tenantId, actor.agentId, this.clock.now().toISOString(), `%${escaped}%`, actor.principalId,
      actor.conversationId ?? "", actor.threadId ?? "", actor.projectId ?? "",
      Math.max(1, Math.min(100, Math.floor(limit))),
    );
    return rows.map((row: Record<string, unknown>) => toRecord(row));
  }

  listPendingOutbox(limit = 100): ProjectionOutboxRowV2[] {
    return this.requireDb().prepare(`SELECT o.*,o.rowid AS mutation_order FROM projection_outbox o
      WHERE o.processed_at IS NULL AND o.available_at <= ?
      ORDER BY o.rowid LIMIT ?`)
      .all(this.clock.now().toISOString(), Math.max(1, Math.min(1000, Math.floor(limit))))
      .map((row: Record<string, unknown>) => this.toOutboxRow(row));
  }

  inspectOutbox(outboxIds: string[]): ProjectionOutboxRowV2[] {
    const unique = [...new Set(outboxIds.filter((value) => typeof value === "string" && value.trim()))];
    if (unique.length === 0) return [];
    if (unique.length > 100) throw new Error("outbox inspection is limited to 100 ids");
    const placeholders = unique.map(() => "?").join(",");
    return this.requireDb().prepare(`SELECT o.*,o.rowid AS mutation_order FROM projection_outbox o
      WHERE o.outbox_id IN (${placeholders})`)
      .all(...unique)
      .map((row: Record<string, unknown>) => this.toOutboxRow(row));
  }

  claimNextOutbox(input: ClaimProjectionOutboxV2Input): ProjectionOutboxClaimV2 | null {
    const owner = normalizeTruthIdentifier(input.owner, "outbox claim owner", 512);
    const leaseDurationMs = this.normalizeLeaseDuration(input.leaseDurationMs);
    const excluded = [...new Set((input.excludeOutboxIds ?? []).map((value) =>
      normalizeTruthIdentifier(value, "excluded outbox id", 512)))];
    if (excluded.length > 1000) throw new Error("outbox claim exclusion is limited to 1000 ids");
    const db = this.requireDb();
    const now = this.clock.now();
    const claimedAt = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    return this.transaction(() => {
      db.prepare(`DELETE FROM projection_outbox_claims
        WHERE lease_expires_at <= ? OR outbox_id IN
          (SELECT outbox_id FROM projection_outbox WHERE processed_at IS NOT NULL)`)
        .run(claimedAt);
      const exclusionSql = excluded.length > 0
        ? `AND o.outbox_id NOT IN (${excluded.map(() => "?").join(",")})`
        : "";
      const row = db.prepare(`SELECT o.*,o.rowid AS mutation_order FROM projection_outbox o
        LEFT JOIN projection_outbox_claims c ON c.outbox_id=o.outbox_id
        WHERE o.processed_at IS NULL AND o.available_at <= ? AND c.outbox_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM projection_outbox earlier
          WHERE earlier.item_id=o.item_id AND earlier.projection=o.projection
            AND earlier.processed_at IS NULL AND earlier.rowid < o.rowid
        )
        ${exclusionSql}
        ORDER BY o.rowid LIMIT 1`).get(claimedAt, ...excluded) as Record<string, unknown> | undefined;
      if (!row) return null;
      const token = randomUUID();
      db.prepare(`INSERT INTO projection_outbox_claims
        (outbox_id,claim_token,claim_owner,claimed_at,lease_expires_at)
        VALUES (?,?,?,?,?)`).run(String(row.outbox_id), token, owner, claimedAt, leaseExpiresAt);
      return { row: this.toOutboxRow(row), owner, token, leaseExpiresAt };
    });
  }

  renewOutboxClaim(claim: ProjectionOutboxClaimV2, leaseDurationMs: number): boolean {
    const normalized = this.normalizeOutboxClaim(claim);
    const duration = this.normalizeLeaseDuration(leaseDurationMs);
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + duration).toISOString();
    const result = this.requireDb().prepare(`UPDATE projection_outbox_claims
      SET lease_expires_at=?
      WHERE outbox_id=? AND claim_token=? AND claim_owner=? AND lease_expires_at > ?
        AND EXISTS (SELECT 1 FROM projection_outbox o
          WHERE o.outbox_id=projection_outbox_claims.outbox_id AND o.processed_at IS NULL)`)
      .run(leaseExpiresAt, normalized.outboxId, normalized.token, normalized.owner, nowIso);
    return Number(result.changes ?? 0) === 1;
  }

  listMemoryCenterRows(actor: MemoryAddressV2, limit = 200): MemoryCenterRowV1[] {
    const validation = validateMemoryAddress(actor);
    if (!validation.valid) return [];
    const rows = this.requireDb().prepare(`SELECT i.*,
      (SELECT source_type FROM memory_sources s WHERE s.revision_id=i.current_revision_id
        ORDER BY observed_at DESC,source_id LIMIT 1) AS source_type,
      (SELECT external_id FROM memory_sources s WHERE s.revision_id=i.current_revision_id
        ORDER BY observed_at DESC,source_id LIMIT 1) AS source_external_id,
      (SELECT observed_at FROM memory_sources s WHERE s.revision_id=i.current_revision_id
        ORDER BY observed_at DESC,source_id LIMIT 1) AS source_observed_at,
      (SELECT event_type FROM memory_events e WHERE e.item_id=i.item_id
        ORDER BY created_at DESC,event_id DESC LIMIT 1) AS latest_event_type,
      (SELECT reason FROM memory_events e WHERE e.item_id=i.item_id
        ORDER BY created_at DESC,event_id DESC LIMIT 1) AS latest_reason
      FROM memory_items i WHERE ${this.accessSql("i")}
      ORDER BY i.updated_at DESC,i.item_id ASC LIMIT ?`)
      .all(...this.accessArgs(actor), Math.max(1, Math.min(1000, Math.floor(limit))));
    return rows.map((row: Record<string, unknown>) => ({
      itemId: String(row.item_id),
      content: String(row.content),
      category: String(row.category),
      address: parseAddress(row),
      lifecycle: row.lifecycle as MemoryLifecycleV2,
      verification: row.verification as MemoryVerificationV2,
      validUntil: row.valid_until ? String(row.valid_until) : undefined,
      updatedAt: String(row.updated_at),
      sourceType: row.source_type ? String(row.source_type) : undefined,
      sourceId: row.source_external_id ? String(row.source_external_id) : undefined,
      observedAt: row.source_observed_at ? String(row.source_observed_at) : undefined,
      latestEventType: row.latest_event_type ? String(row.latest_event_type) : undefined,
      latestReason: row.latest_reason ? String(row.latest_reason) : undefined,
    }));
  }

  listMemoryCenterEvents(actor: MemoryAddressV2, limit = 200): MemoryCenterEventRowV1[] {
    if (!validateMemoryAddress(actor).valid) return [];
    return this.requireDb().prepare(`SELECT e.* FROM memory_events e
      JOIN memory_items i ON i.item_id=e.item_id
      WHERE ${this.accessSql("i")}
      ORDER BY e.created_at DESC,e.event_id DESC LIMIT ?`)
      .all(...this.accessArgs(actor), Math.max(1, Math.min(1000, Math.floor(limit))))
      .map((row: Record<string, unknown>) => ({
        eventId: String(row.event_id), itemId: String(row.item_id),
        eventType: String(row.event_type), reason: String(row.reason), createdAt: String(row.created_at),
      }));
  }

  listMemoryCenterRelations(actor: MemoryAddressV2, limit = 200): MemoryCenterRelationRowV1[] {
    if (!validateMemoryAddress(actor).valid) return [];
    return this.requireDb().prepare(`SELECT r.relation_type,r.created_at,
      fr.item_id AS from_item_id,tr.item_id AS to_item_id
      FROM memory_relations r
      JOIN memory_revisions fr ON fr.revision_id=r.from_revision_id
      JOIN memory_revisions tr ON tr.revision_id=r.to_revision_id
      JOIN memory_items fi ON fi.item_id=fr.item_id
      JOIN memory_items ti ON ti.item_id=tr.item_id
      WHERE fi.current_revision_id=fr.revision_id
        AND ti.current_revision_id=tr.revision_id
        AND ${this.accessSql("fi")} AND ${this.accessSql("ti")}
      ORDER BY r.created_at DESC,r.relation_id DESC LIMIT ?`)
      .all(...this.accessArgs(actor), ...this.accessArgs(actor), Math.max(1, Math.min(1000, Math.floor(limit))))
      .map((row: Record<string, unknown>) => ({
        relationType: String(row.relation_type), fromItemId: String(row.from_item_id),
        toItemId: String(row.to_item_id), createdAt: String(row.created_at),
      }));
  }

  getMemoryCenterProjectionHealth(actor: MemoryAddressV2): MemoryCenterProjectionHealthV1 {
    if (!validateMemoryAddress(actor).valid) return { pending: 0, retrying: 0, processed: 0 };
    const row = this.requireDb().prepare(`SELECT
      SUM(CASE WHEN o.processed_at IS NULL AND o.attempts=0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN o.processed_at IS NULL AND o.attempts>0 THEN 1 ELSE 0 END) AS retrying,
      SUM(CASE WHEN o.processed_at IS NOT NULL THEN 1 ELSE 0 END) AS processed
      FROM projection_outbox o JOIN memory_items i ON i.item_id=o.item_id
      WHERE ${this.accessSql("i")}`).get(...this.accessArgs(actor)) as Record<string, unknown>;
    return {
      pending: Number(row.pending ?? 0),
      retrying: Number(row.retrying ?? 0),
      processed: Number(row.processed ?? 0),
    };
  }

  markOutboxProcessed(claim: ProjectionOutboxClaimV2): boolean {
    const normalized = this.normalizeOutboxClaim(claim);
    const db = this.requireDb();
    const now = this.clock.now().toISOString();
    return this.transaction(() => {
      const result = db.prepare(`UPDATE projection_outbox SET processed_at=?
        WHERE outbox_id=? AND processed_at IS NULL AND EXISTS (
          SELECT 1 FROM projection_outbox_claims c
          WHERE c.outbox_id=projection_outbox.outbox_id
            AND c.claim_token=? AND c.claim_owner=? AND c.lease_expires_at > ?
        )`).run(now, normalized.outboxId, normalized.token, normalized.owner, now);
      if (Number(result.changes ?? 0) !== 1) return false;
      db.prepare(`DELETE FROM projection_outbox_claims
        WHERE outbox_id=? AND claim_token=? AND claim_owner=?`)
        .run(normalized.outboxId, normalized.token, normalized.owner);
      return true;
    });
  }

  recordOutboxFailure(claim: ProjectionOutboxClaimV2, errorCode: string, retryAt?: string): boolean {
    const normalized = this.normalizeOutboxClaim(claim);
    const normalizedCode = normalizeTruthIdentifier(errorCode, "outbox error code", 160);
    const normalizedRetryAt = retryAt == null
      ? this.clock.now().toISOString()
      : normalizeIsoTimestamp(retryAt, "outbox retryAt");
    const db = this.requireDb();
    const now = this.clock.now().toISOString();
    return this.transaction(() => {
      const result = db.prepare(`UPDATE projection_outbox
        SET attempts=attempts+1,last_error=?,available_at=?
        WHERE outbox_id=? AND processed_at IS NULL AND EXISTS (
          SELECT 1 FROM projection_outbox_claims c
          WHERE c.outbox_id=projection_outbox.outbox_id
            AND c.claim_token=? AND c.claim_owner=? AND c.lease_expires_at > ?
        )`).run(
        normalizedCode, normalizedRetryAt, normalized.outboxId,
        normalized.token, normalized.owner, now,
      );
      if (Number(result.changes ?? 0) !== 1) return false;
      db.prepare(`DELETE FROM projection_outbox_claims
        WHERE outbox_id=? AND claim_token=? AND claim_owner=?`)
        .run(normalized.outboxId, normalized.token, normalized.owner);
      return true;
    });
  }

  count(table: string): number {
    const allowed = new Set(["memory_item_identities","memory_items","memory_revisions","memory_sources","memory_acl","memory_relations","memory_events","projection_outbox"]);
    if (!allowed.has(table)) throw new Error("unsupported table");
    return Number(this.requireDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  }

  private assertAddress(address: MemoryAddressV2): void {
    const validation = validateMemoryAddress(address);
    if (!validation.valid) throw new Error(`invalid memory address: ${validation.errors.map((item) => item.code).join(",")}`);
    assertMemoryAddressIdentifiersSafe(address);
  }

  private normalizeLeaseDuration(value: number): number {
    if (!Number.isSafeInteger(value) || value < 100 || value > 3_600_000) {
      throw new Error("outbox lease duration must be an integer between 100 and 3600000 milliseconds");
    }
    return value;
  }

  private normalizeOutboxClaim(claim: ProjectionOutboxClaimV2): {
    outboxId: string;
    token: string;
    owner: string;
  } {
    if (!claim || typeof claim !== "object" || !claim.row) throw new Error("outbox claim is required");
    return {
      outboxId: normalizeTruthIdentifier(claim.row.outboxId, "outbox id", 512),
      token: normalizeTruthIdentifier(claim.token, "outbox claim token", 512),
      owner: normalizeTruthIdentifier(claim.owner, "outbox claim owner", 512),
    };
  }

  private transaction<T>(action: () => T): T {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original transaction failure */ }
      throw error;
    }
  }

  private insertSource(revisionId: string, source: MemorySourceV2): void {
    this.requireDb().prepare(`INSERT INTO memory_sources
      (source_id,revision_id,source_type,external_id,observed_at,evidence_json)
      VALUES (?,?,?,?,?,?)`).run(
      this.clock.id(), revisionId, source.sourceType, source.sourceId ?? null,
      source.observedAt, json(source.evidence),
    );
  }

  private insertEvent(eventId: string, itemId: string, revisionId: string | undefined, eventType: string, actor: string, reason: string, now: string): void {
    this.requireDb().prepare(`INSERT INTO memory_events
      (event_id,item_id,revision_id,event_type,actor,reason,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(eventId, itemId, revisionId ?? null, eventType, actor, reason, now);
  }

  private insertOutbox(ids: string[], itemId: string, revisionId: string | undefined, operation: string, now: string): void {
    PROJECTIONS.forEach((projection, index) => {
      this.requireDb().prepare(`INSERT INTO projection_outbox
        (outbox_id,item_id,revision_id,operation,projection,attempts,available_at,created_at)
        VALUES (?,?,?,?,?,0,?,?)`).run(ids[index], itemId, revisionId ?? null, operation, projection, now, now);
    });
  }

  private toOutboxRow(row: Record<string, unknown>): ProjectionOutboxRowV2 {
    return {
      outboxId: String(row.outbox_id), itemId: String(row.item_id),
      mutationOrder: Number(row.mutation_order),
      revisionId: row.revision_id ? String(row.revision_id) : undefined,
      operation: row.operation as ProjectionOutboxRowV2["operation"],
      projection: row.projection as ProjectionOutboxRowV2["projection"],
      attempts: Number(row.attempts), availableAt: String(row.available_at),
      createdAt: String(row.created_at),
      processedAt: row.processed_at ? String(row.processed_at) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
    };
  }

  private accessSql(alias: string): string {
    return `${alias}.tenant_id=? AND ${alias}.agent_id=? AND (
      (${alias}.visibility='private' AND ${alias}.principal_id=?)
      OR (${alias}.visibility='conversation' AND ${alias}.conversation_id=?
        AND (${alias}.thread_id IS NULL OR ${alias}.thread_id=?))
      OR (${alias}.visibility='project' AND ${alias}.project_id=?)
    )`;
  }

  private accessArgs(actor: MemoryAddressV2): unknown[] {
    return [
      actor.tenantId, actor.agentId, actor.principalId,
      actor.conversationId ?? "", actor.threadId ?? "", actor.projectId ?? "",
    ];
  }

  private ensureSchema(): void {
    const db = this.requireDb();
    const existing = Number(db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='memory_items'",
    ).get().count) > 0;
    if (existing) {
      const version = Number(db.prepare(
        "SELECT COALESCE(MAX(version),0) AS version FROM clawlore_schema",
      ).get().version);
      const identities = Number(db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='memory_item_identities'",
      ).get().count);
      const revisionForeignKeys = (db.prepare("PRAGMA foreign_key_list(memory_revisions)").all() as unknown[]).length;
      if (version < 3 || identities !== 1 || revisionForeignKeys === 0) {
        throw new Error("Truth V2 database requires the controlled schema-integrity migration");
      }
    }
    db.exec(TRUTH_V2_SCHEMA_SQL);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error("truth store is not open");
    return this.db;
  }
}
