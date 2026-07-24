import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type { MemoryAddressV2 } from "../domain/memory-address.js";
import { validateMemoryAddress } from "../domain/memory-address.js";
import {
  normalizeTruthIdentifier,
  normalizeTruthSemanticText,
} from "../domain/truth-write-policy.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export interface RuntimeV1V2MirrorInputV1 {
  legacyId: string;
  content: string;
  category: string;
  address: MemoryAddressV2;
  observedAt: string;
  actor: string;
}

export interface RuntimeV1V2MirrorReceiptV1 {
  schemaVersion: 1;
  status: "mirrored" | "already_mirrored";
  itemId: string;
  projectionStatus: "converged";
}

function requiredTables(db: DatabaseSync): void {
  const required = [
    "memory_items",
    "memory_revisions",
    "memory_sources",
    "memory_acl",
    "memory_events",
    "projection_outbox",
    "memory_fts_v2",
    "memory_vector_projection_v2",
    "memory_relation_projection_v2",
  ];
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN (${required.map(() => "?").join(",")})`,
  ).all(...required) as Array<{ name: string }>;
  const found = new Set(rows.map((row) => String(row.name)));
  const missing = required.filter((name) => !found.has(name));
  if (missing.length > 0) throw new Error(`v2_runtime_schema_missing:${missing.join(",")}`);
}

/**
 * Mirrors one already-committed V1 manual write into V2 truth and all local
 * projections in one SQLite transaction. The caller must compensate the V1
 * write if this transaction fails, so a tool can never report a false success.
 */
export function mirrorRuntimeV1WriteToV2(
  sqlitePath: string,
  input: RuntimeV1V2MirrorInputV1,
): RuntimeV1V2MirrorReceiptV1 {
  const validation = validateMemoryAddress(input.address);
  if (!validation.valid) throw new Error("v2_runtime_address_invalid");
  const legacyId = normalizeTruthIdentifier(input.legacyId, "legacy id", 512);
  const content = normalizeTruthSemanticText(input.content, "memory content", 64_000, {
    collapseWhitespace: false,
  });
  const category = normalizeTruthIdentifier(input.category, "memory category", 256);
  const actor = normalizeTruthIdentifier(input.actor, "memory actor", 512);
  const observedAt = new Date(input.observedAt).toISOString();
  const itemId = `legacy:${legacyId}`;
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
    requiredTables(db);
    const existing = db.prepare(
      "SELECT content,address_json,lifecycle,verification FROM memory_items WHERE item_id=?",
    ).get(itemId) as Record<string, unknown> | undefined;
    if (existing) {
      if (
        String(existing.content) !== content
        || String(existing.address_json) !== JSON.stringify(input.address)
        || String(existing.lifecycle) !== "active"
        || String(existing.verification) !== "user_confirmed"
      ) {
        throw new Error("v2_runtime_existing_mirror_conflict");
      }
      return { schemaVersion: 1, status: "already_mirrored", itemId, projectionStatus: "converged" };
    }
    const now = observedAt;
    const revisionId = randomUUID();
    const sourceId = randomUUID();
    const aclId = randomUUID();
    const eventId = randomUUID();
    const projections = ["fts", "vector", "relations"] as const;
    db.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;");
    try {
      db.prepare(`INSERT INTO memory_revisions
        (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
        VALUES (?,?,1,?,'active','user_confirmed',NULL,?)`)
        .run(revisionId, itemId, content, now);
      db.prepare(`INSERT INTO memory_items
        (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
         visibility,retention,workspace_id,project_id,conversation_id,thread_id,customer_id,task_id,
         lifecycle,verification,valid_until,created_at,updated_at)
        VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active','user_confirmed',NULL,?,?)`)
        .run(
          itemId, revisionId, content, category, JSON.stringify(input.address),
          input.address.tenantId, input.address.principalId, input.address.agentId,
          input.address.visibility, input.address.retention, input.address.workspaceId ?? null,
          input.address.projectId ?? null, input.address.conversationId ?? null,
          input.address.threadId ?? null, input.address.customerId ?? null, input.address.taskId ?? null,
          now, now,
        );
      db.prepare(`INSERT INTO memory_sources
        (source_id,revision_id,source_type,external_id,observed_at,evidence_json)
        VALUES (?,?,'tool',?,?,?)`)
        .run(sourceId, revisionId, legacyId, now, JSON.stringify({ runtimeMirror: "v1-v2" }));
      db.prepare(`INSERT INTO memory_acl
        (acl_id,item_id,owner_principal_id,visibility,policy_json,created_at)
        VALUES (?,?,?,?,?,?)`)
        .run(aclId, itemId, input.address.principalId, input.address.visibility, "{}", now);
      db.prepare(`INSERT INTO memory_events
        (event_id,item_id,revision_id,event_type,actor,reason,created_at)
        VALUES (?,?,?,'remembered',?,'runtime_manual_write',?)`)
        .run(eventId, itemId, revisionId, actor, now);
      db.prepare("INSERT INTO memory_fts_v2(item_id,content,category) VALUES (?,?,?)")
        .run(itemId, content, category);
      db.prepare(`INSERT INTO memory_vector_projection_v2
        (item_id,legacy_id,backend,state,verified_at)
        VALUES (?,?,'v1-lancedb-fallback','fallback_verified',?)`)
        .run(itemId, legacyId, now);
      db.prepare(`INSERT INTO memory_relation_projection_v2
        (item_id,state,verified_at) VALUES (?,'no_legacy_relation_source',?)`)
        .run(itemId, now);
      for (const projection of projections) {
        db.prepare(`INSERT INTO projection_outbox
          (outbox_id,item_id,revision_id,operation,projection,attempts,available_at,created_at,processed_at,last_error)
          VALUES (?,?,?,'upsert',?,0,?,?,?,NULL)`)
          .run(randomUUID(), itemId, revisionId, projection, now, now, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
    return { schemaVersion: 1, status: "mirrored", itemId, projectionStatus: "converged" };
  } finally {
    db.close();
  }
}

export function runtimeV2MirrorToolContext(
  sqlitePath: string,
  enabled: boolean,
): {
  v2RuntimeMirror?: {
    mirror: (input: RuntimeV1V2MirrorInputV1) => RuntimeV1V2MirrorReceiptV1;
  };
} {
  return enabled
    ? { v2RuntimeMirror: { mirror: (input) => mirrorRuntimeV1WriteToV2(sqlitePath, input) } }
    : {};
}
