import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { MemoryAddressV2 } from "../domain/memory-address.js";
import { validateMemoryAddress } from "../domain/memory-address.js";
import type {
  MemoryLifecycleV2,
  MemoryMutationReceiptV2,
  MemoryRecordV2,
  MemorySourceV2,
  MemoryVerificationV2,
} from "../domain/memory-record.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface TruthStoreClock {
  now(): Date;
  id(): string;
}

export interface RememberMemoryV2Input {
  itemId?: string;
  content: string;
  category: string;
  address: MemoryAddressV2;
  lifecycle?: MemoryLifecycleV2;
  verification?: MemoryVerificationV2;
  validUntil?: string;
  source: MemorySourceV2;
  actor: string;
  reason: string;
}

export interface CorrectMemoryV2Input {
  itemId: string;
  content: string;
  source: MemorySourceV2;
  actor: string;
  reason: string;
  verification?: MemoryVerificationV2;
  validUntil?: string;
}

export interface ForgetMemoryV2Input {
  itemId: string;
  hardDelete?: boolean;
  approved?: boolean;
  actor: string;
  reason: string;
}

export interface ProjectionOutboxRowV2 {
  outboxId: string;
  itemId: string;
  revisionId?: string;
  operation: "upsert" | "delete" | "purge";
  projection: "fts" | "vector" | "relations";
  attempts: number;
  availableAt: string;
  processedAt?: string;
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

export class SqliteTruthStoreV2 {
  private db: DatabaseSync | null = null;

  constructor(
    private readonly sqlitePath: string,
    private readonly clock: TruthStoreClock = DEFAULT_CLOCK,
  ) {}

  open(): void {
    if (this.db) return;
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    mkdirSync(dirname(this.sqlitePath), { recursive: true });
    this.db = new DatabaseSync(this.sqlitePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.ensureSchema();
  }

  close(): void {
    this.db?.close?.();
    this.db = null;
  }

  remember(input: RememberMemoryV2Input): MemoryMutationReceiptV2 {
    this.assertWriteInput(input.content, input.address, input.actor, input.reason);
    const db = this.requireDb();
    const now = this.clock.now().toISOString();
    const itemId = input.itemId ?? this.clock.id();
    const revisionId = this.clock.id();
    const eventId = this.clock.id();
    const outboxIds = [this.clock.id(), this.clock.id(), this.clock.id()];
    this.transaction(() => {
      db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        revisionId, itemId, 1, input.content.trim(), input.lifecycle ?? "active",
        input.verification ?? "unverified", input.validUntil ?? null, now,
      );
      db.prepare(`INSERT INTO memory_items
        (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
         visibility,retention,workspace_id,project_id,conversation_id,thread_id,customer_id,task_id,
         lifecycle,verification,valid_until,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        itemId, revisionId, 1, input.content.trim(), input.category.trim(), json(input.address),
        input.address.tenantId, input.address.principalId, input.address.agentId,
        input.address.visibility, input.address.retention, input.address.workspaceId ?? null,
        input.address.projectId ?? null, input.address.conversationId ?? null,
        input.address.threadId ?? null, input.address.customerId ?? null, input.address.taskId ?? null,
        input.lifecycle ?? "active", input.verification ?? "unverified", input.validUntil ?? null, now, now,
      );
      this.insertSource(revisionId, input.source);
      db.prepare(`INSERT INTO memory_acl (acl_id,item_id,owner_principal_id,visibility,policy_json,created_at)
        VALUES (?,?,?,?,?,?)`).run(this.clock.id(), itemId, input.address.principalId, input.address.visibility, "{}", now);
      this.insertEvent(eventId, itemId, revisionId, "remembered", input.actor, input.reason, now);
      this.insertOutbox(outboxIds, itemId, revisionId, "upsert", now);
    });
    return { schemaVersion: 2, action: "remember", itemId, revisionId, eventId, outboxIds, committedAt: now };
  }

  correct(input: CorrectMemoryV2Input): MemoryMutationReceiptV2 {
    if (!input.content.trim()) throw new Error("content is required");
    if (!input.actor.trim() || !input.reason.trim()) throw new Error("actor and reason are required");
    const db = this.requireDb();
    const current = this.get(input.itemId);
    if (!current) throw new Error("memory item not found");
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
        revisionId, current.itemId, current.revision + 1, input.content.trim(), "active",
        input.verification ?? current.verification, input.validUntil ?? current.validUntil ?? null, now,
      );
      db.prepare(`UPDATE memory_items SET current_revision_id=?,revision_no=?,content=?,lifecycle='active',
        verification=?,valid_until=?,updated_at=? WHERE item_id=?`).run(
        revisionId, current.revision + 1, input.content.trim(), input.verification ?? current.verification,
        input.validUntil ?? current.validUntil ?? null, now, current.itemId,
      );
      this.insertSource(revisionId, input.source);
      db.prepare(`INSERT INTO memory_relations
        (relation_id,from_revision_id,to_revision_id,relation_type,created_at)
        VALUES (?,?,?,?,?)`).run(this.clock.id(), revisionId, current.revisionId, "supersedes", now);
      this.insertEvent(eventId, current.itemId, revisionId, "corrected", input.actor, input.reason, now);
      this.insertOutbox(outboxIds, current.itemId, revisionId, "upsert", now);
    });
    return {
      schemaVersion: 2, action: "correct", itemId: current.itemId, revisionId,
      previousRevisionId: current.revisionId, eventId, outboxIds, committedAt: now,
    };
  }

  forget(input: ForgetMemoryV2Input): MemoryMutationReceiptV2 {
    if (!input.actor.trim() || !input.reason.trim()) throw new Error("actor and reason are required");
    if (input.hardDelete && input.approved !== true) throw new Error("hard delete requires explicit approval");
    const db = this.requireDb();
    const current = this.get(input.itemId);
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
      this.insertEvent(eventId, current.itemId, revisionId, input.hardDelete ? "purged" : "archived", input.actor, input.reason, now);
      this.insertOutbox(outboxIds, current.itemId, revisionId, operation, now);
    });
    return {
      schemaVersion: 2, action: input.hardDelete ? "purge" : "archive",
      itemId: current.itemId, revisionId, previousRevisionId: current.revisionId,
      eventId, outboxIds, committedAt: now,
    };
  }

  get(itemId: string): MemoryRecordV2 | null {
    const row = this.requireDb().prepare("SELECT * FROM memory_items WHERE item_id=? LIMIT 1").get(itemId);
    return row ? toRecord(row as Record<string, unknown>) : null;
  }

  listPendingOutbox(limit = 100): ProjectionOutboxRowV2[] {
    return this.requireDb().prepare(`SELECT * FROM projection_outbox WHERE processed_at IS NULL
      AND available_at <= ? ORDER BY created_at,outbox_id LIMIT ?`)
      .all(this.clock.now().toISOString(), Math.max(1, Math.min(1000, Math.floor(limit))))
      .map((row: Record<string, unknown>) => ({
        outboxId: String(row.outbox_id), itemId: String(row.item_id),
        revisionId: row.revision_id ? String(row.revision_id) : undefined,
        operation: row.operation as ProjectionOutboxRowV2["operation"],
        projection: row.projection as ProjectionOutboxRowV2["projection"],
        attempts: Number(row.attempts), availableAt: String(row.available_at),
        processedAt: row.processed_at ? String(row.processed_at) : undefined,
      }));
  }

  markOutboxProcessed(outboxId: string): void {
    this.requireDb().prepare("UPDATE projection_outbox SET processed_at=? WHERE outbox_id=?")
      .run(this.clock.now().toISOString(), outboxId);
  }

  count(table: string): number {
    const allowed = new Set(["memory_items","memory_revisions","memory_sources","memory_acl","memory_relations","memory_events","projection_outbox"]);
    if (!allowed.has(table)) throw new Error("unsupported table");
    return Number(this.requireDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  }

  private assertWriteInput(content: string, address: MemoryAddressV2, actor: string, reason: string): void {
    if (!content.trim()) throw new Error("content is required");
    const validation = validateMemoryAddress(address);
    if (!validation.valid) throw new Error(`invalid memory address: ${validation.errors.map((item) => item.code).join(",")}`);
    if (!actor.trim() || !reason.trim()) throw new Error("actor and reason are required");
  }

  private transaction<T>(action: () => T): T {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
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
    ["fts", "vector", "relations"].forEach((projection, index) => {
      this.requireDb().prepare(`INSERT INTO projection_outbox
        (outbox_id,item_id,revision_id,operation,projection,attempts,available_at,created_at)
        VALUES (?,?,?,?,?,0,?,?)`).run(ids[index], itemId, revisionId ?? null, operation, projection, now, now);
    });
  }

  private ensureSchema(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS clawlore_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_items (
        item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
        content TEXT NOT NULL,category TEXT NOT NULL,address_json TEXT NOT NULL,
        tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,agent_id TEXT NOT NULL,
        visibility TEXT NOT NULL,retention TEXT NOT NULL,workspace_id TEXT,project_id TEXT,
        conversation_id TEXT,thread_id TEXT,customer_id TEXT,task_id TEXT,
        lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_revisions (
        revision_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_no INTEGER NOT NULL,
        content TEXT NOT NULL,lifecycle TEXT NOT NULL,verification TEXT NOT NULL,valid_until TEXT,
        created_at TEXT NOT NULL,UNIQUE(item_id,revision_no)
      );
      CREATE TABLE IF NOT EXISTS memory_sources (
        source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,source_type TEXT NOT NULL,
        external_id TEXT,observed_at TEXT NOT NULL,evidence_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_acl (
        acl_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,owner_principal_id TEXT NOT NULL,
        visibility TEXT NOT NULL,policy_json TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_relations (
        relation_id TEXT PRIMARY KEY,from_revision_id TEXT NOT NULL,to_revision_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_events (
        event_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_id TEXT,event_type TEXT NOT NULL,
        actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_outbox (
        outbox_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,revision_id TEXT,operation TEXT NOT NULL,
        projection TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,processed_at TEXT,last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_access ON memory_items
        (tenant_id,principal_id,agent_id,visibility,lifecycle,verification);
      CREATE INDEX IF NOT EXISTS idx_memory_conversation ON memory_items
        (tenant_id,conversation_id,thread_id,lifecycle);
      CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_items
        (tenant_id,project_id,customer_id,lifecycle);
      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON projection_outbox
        (processed_at,available_at,projection);
      INSERT OR IGNORE INTO clawlore_schema(version,applied_at) VALUES (2,datetime('now'));
    `);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error("truth store is not open");
    return this.db;
  }
}
