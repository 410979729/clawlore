import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { enforcePrivatePath, ensurePrivateDirectory } from "../../file-privacy.js";
import type { ExperienceStoreV2Port } from "../application/ports/experience-store.js";
import type {
  ChildScratchV2,
  ExperienceEpisodeV2,
  ExperienceEventV2,
  ProceduralPlaybookV2,
  SubagentSnapshotV2,
} from "../domain/experience.js";
import {
  assertChildScratchSafeForPersistence,
  assertExperienceEpisodeSafeForPersistence,
  assertExperienceEventSafeForPersistence,
  assertProceduralPlaybookSafeForPersistence,
  assertSubagentSnapshotSafeForPersistence,
} from "../domain/experience-write-policy.js";
import { memoryAddressKey } from "../domain/memory-address.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

export const EXPERIENCE_V2_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS subagent_snapshots_v2 (
    snapshot_id TEXT PRIMARY KEY,parent_session_id TEXT NOT NULL,child_session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_snapshot_run_v2
    ON subagent_snapshots_v2(parent_session_id,child_session_id,run_id);
  CREATE TABLE IF NOT EXISTS subagent_scratch_v2 (
    scratch_id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,child_session_id TEXT NOT NULL,
    retention TEXT NOT NULL,lifecycle TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,
    FOREIGN KEY(snapshot_id) REFERENCES subagent_snapshots_v2(snapshot_id)
  );
  CREATE TABLE IF NOT EXISTS experience_episodes_v2 (
    episode_id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,parent_session_id TEXT NOT NULL,
    child_session_id TEXT NOT NULL,run_id TEXT NOT NULL,task_class TEXT NOT NULL,outcome TEXT NOT NULL,
    parent_verification TEXT NOT NULL,lifecycle TEXT NOT NULL,payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    FOREIGN KEY(snapshot_id) REFERENCES subagent_snapshots_v2(snapshot_id)
  );
  CREATE INDEX IF NOT EXISTS idx_experience_episode_review_v2
    ON experience_episodes_v2(task_class,parent_verification,lifecycle);
  CREATE TABLE IF NOT EXISTS procedural_playbooks_v2 (
    playbook_id TEXT PRIMARY KEY,version INTEGER NOT NULL,task_class TEXT NOT NULL,
    lifecycle TEXT NOT NULL,operator_reviewed INTEGER NOT NULL,predecessor_id TEXT,
    superseded_by TEXT,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_playbook_lifecycle_v2
    ON procedural_playbooks_v2(task_class,lifecycle);
  CREATE TABLE IF NOT EXISTS experience_events_v2 (
    event_id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_experience_event_entity_v2
    ON experience_events_v2(entity_type,entity_id,created_at);
`;

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function withoutKeys(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}

function isPersistedJsonEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left)),
    JSON.parse(JSON.stringify(right)),
  );
}

function enforcePrivateSqliteFamily(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) enforcePrivatePath(candidate, { kind: "file" });
  }
}

export class SqliteExperienceStoreV2 implements ExperienceStoreV2Port {
  private db: DatabaseSync | null = null;

  constructor(private readonly path: string) {}

  open(): void {
    if (this.db) return;
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    ensurePrivateDirectory(dirname(this.path));
    enforcePrivateSqliteFamily(this.path);
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.ensureSchema();
    enforcePrivateSqliteFamily(this.path);
  }

  close(): void {
    this.db?.close();
    this.db = null;
    enforcePrivateSqliteFamily(this.path);
  }

  saveSnapshot(snapshot: SubagentSnapshotV2, event?: ExperienceEventV2): void {
    assertSubagentSnapshotSafeForPersistence(snapshot);
    if (snapshot.status !== "active") throw new Error("new subagent snapshot must be active");
    if (event) this.assertLinkedEvent(event, "snapshot", snapshot.snapshotId);
    const action = () => {
      this.requireDb().prepare(`INSERT INTO subagent_snapshots_v2
        (snapshot_id,parent_session_id,child_session_id,run_id,mode,status,payload_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        snapshot.snapshotId, snapshot.parentSessionId, snapshot.childSessionId,
        snapshot.runId, snapshot.mode, snapshot.status, JSON.stringify(snapshot), snapshot.createdAt,
      );
      if (event) this.insertEvent(event);
    };
    if (event) this.transaction(action);
    else action();
  }

  getSnapshot(snapshotId: string): SubagentSnapshotV2 | null {
    const row = this.requireDb().prepare("SELECT payload_json FROM subagent_snapshots_v2 WHERE snapshot_id=?")
      .get(snapshotId) as Record<string, unknown> | undefined;
    return row ? parseJson<SubagentSnapshotV2>(row.payload_json) : null;
  }

  saveScratch(scratch: ChildScratchV2, event?: ExperienceEventV2): void {
    assertChildScratchSafeForPersistence(scratch);
    if (event) this.assertLinkedEvent(event, "scratch", scratch.scratchId);
    const db = this.requireDb();
    this.transaction(() => {
      const result = db.prepare(`INSERT INTO subagent_scratch_v2
        (scratch_id,snapshot_id,child_session_id,retention,lifecycle,payload_json,created_at)
        SELECT ?,snapshot_id,child_session_id,?,?,?,?
        FROM subagent_snapshots_v2
        WHERE snapshot_id=? AND child_session_id=? AND status='active'`).run(
        scratch.scratchId, scratch.retention, scratch.lifecycle, JSON.stringify(scratch),
        scratch.createdAt, scratch.snapshotId, scratch.childSessionId,
      );
      if (Number(result.changes) !== 1) {
        throw new Error("active child-owned snapshot is required for scratch persistence");
      }
      if (event) this.insertEvent(event);
    });
  }

  finalizeSnapshot(
    snapshot: SubagentSnapshotV2,
    episode: ExperienceEpisodeV2,
    event?: ExperienceEventV2,
  ): void {
    assertSubagentSnapshotSafeForPersistence(snapshot);
    assertExperienceEpisodeSafeForPersistence(episode);
    if (event) this.assertLinkedEvent(event, "episode", episode.episodeId);
    const current = this.getSnapshot(snapshot.snapshotId);
    if (!current || current.status !== "active" || snapshot.status !== "revoked") {
      throw new Error("active snapshot must transition to revoked");
    }
    if (!isDeepStrictEqual(
      withoutKeys(current as unknown as Record<string, unknown>, ["status"]),
      withoutKeys(snapshot as unknown as Record<string, unknown>, ["status"]),
    )) throw new Error("subagent snapshot immutable fields changed during finalization");
    if (episode.parentVerification !== "pending" || episode.lifecycle !== "candidate"
      || episode.snapshotId !== snapshot.snapshotId
      || episode.parentSessionId !== snapshot.parentSessionId
      || episode.childSessionId !== snapshot.childSessionId
      || episode.runId !== snapshot.runId
      || episode.taskGoal !== snapshot.taskGoal
      || memoryAddressKey(episode.actorAddress) !== memoryAddressKey(snapshot.actorAddress)) {
      throw new Error("experience episode does not match its snapshot boundary");
    }
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db.prepare(`UPDATE subagent_snapshots_v2
        SET status=?,payload_json=? WHERE snapshot_id=? AND status='active'`).run(
        snapshot.status, JSON.stringify(snapshot), snapshot.snapshotId,
      );
      if (Number(result.changes) !== 1) throw new Error("active subagent snapshot finalization target missing");
      db.prepare(`INSERT INTO experience_episodes_v2
        (episode_id,snapshot_id,parent_session_id,child_session_id,run_id,task_class,outcome,
         parent_verification,lifecycle,payload_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        episode.episodeId, episode.snapshotId, episode.parentSessionId, episode.childSessionId,
        episode.runId, episode.taskClass, episode.outcome, episode.parentVerification,
        episode.lifecycle, JSON.stringify(episode), episode.createdAt, episode.updatedAt,
      );
      if (event) this.insertEvent(event);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  getEpisode(episodeId: string): ExperienceEpisodeV2 | null {
    const row = this.requireDb().prepare("SELECT payload_json FROM experience_episodes_v2 WHERE episode_id=?")
      .get(episodeId) as Record<string, unknown> | undefined;
    return row ? parseJson<ExperienceEpisodeV2>(row.payload_json) : null;
  }

  updateEpisode(
    episode: ExperienceEpisodeV2,
    expected: ExperienceEpisodeV2,
    event?: ExperienceEventV2,
  ): void {
    assertExperienceEpisodeSafeForPersistence(episode);
    assertExperienceEpisodeSafeForPersistence(expected);
    if (event) this.assertLinkedEvent(event, "episode", episode.episodeId);
    const db = this.requireDb();
    this.transaction(() => {
      const current = this.getEpisode(episode.episodeId);
      if (!current) throw new Error("experience episode update target missing");
      if (!isDeepStrictEqual(current, expected)) {
        throw new Error("experience episode compare-and-set expected state is stale");
      }
      if (!isDeepStrictEqual(
        withoutKeys(expected as unknown as Record<string, unknown>, ["parentVerification", "lifecycle", "verificationReason", "updatedAt"]),
        withoutKeys(episode as unknown as Record<string, unknown>, ["parentVerification", "lifecycle", "verificationReason", "updatedAt"]),
      )) throw new Error("experience episode immutable fields cannot change");
      if (expected.parentVerification !== "pending" || expected.lifecycle !== "candidate") {
        throw new Error("experience episode review is already terminal");
      }
      const result = db.prepare(`UPDATE experience_episodes_v2 SET
        parent_verification=?,lifecycle=?,payload_json=?,updated_at=?
        WHERE episode_id=? AND parent_verification=? AND lifecycle=?`).run(
        episode.parentVerification, episode.lifecycle, JSON.stringify(episode), episode.updatedAt,
        episode.episodeId, expected.parentVerification, expected.lifecycle,
      );
      if (Number(result.changes) !== 1) throw new Error("experience episode compare-and-set failed");
      if (event) this.insertEvent(event);
    });
  }

  listEpisodes(episodeIds: string[]): ExperienceEpisodeV2[] {
    if (episodeIds.length === 0) return [];
    if (episodeIds.length > 256) throw new Error("episode lookup exceeds the size limit");
    const placeholders = episodeIds.map(() => "?").join(",");
    const rows = this.requireDb().prepare(`SELECT payload_json FROM experience_episodes_v2
      WHERE episode_id IN (${placeholders})`).all(...episodeIds) as Array<Record<string, unknown>>;
    return rows.map((row) => parseJson<ExperienceEpisodeV2>(row.payload_json));
  }

  savePlaybook(playbook: ProceduralPlaybookV2, event?: ExperienceEventV2): void {
    assertProceduralPlaybookSafeForPersistence(playbook);
    if (event) this.assertLinkedEvent(event, "playbook", playbook.playbookId);
    if (playbook.lifecycle !== "candidate" || playbook.operatorReviewed || playbook.supersededBy != null) {
      throw new Error("new procedural playbook must begin as an unreviewed candidate");
    }
    this.transaction(() => {
      this.assertPlaybookEvidence(playbook);
      this.insertPlaybook(playbook);
      if (event) this.insertEvent(event);
    });
  }

  getPlaybook(playbookId: string): ProceduralPlaybookV2 | null {
    const row = this.requireDb().prepare("SELECT payload_json FROM procedural_playbooks_v2 WHERE playbook_id=?")
      .get(playbookId) as Record<string, unknown> | undefined;
    return row ? parseJson<ProceduralPlaybookV2>(row.payload_json) : null;
  }

  updatePlaybook(
    playbook: ProceduralPlaybookV2,
    expected: ProceduralPlaybookV2,
    event?: ExperienceEventV2,
  ): void {
    assertProceduralPlaybookSafeForPersistence(playbook);
    assertProceduralPlaybookSafeForPersistence(expected);
    if (event) this.assertLinkedEvent(event, "playbook", playbook.playbookId);
    const db = this.requireDb();
    this.transaction(() => {
      const current = this.getPlaybook(playbook.playbookId);
      if (!current) throw new Error("procedural playbook update target missing");
      if (!isDeepStrictEqual(current, expected)) {
        throw new Error("procedural playbook compare-and-set expected state is stale");
      }
      if (!isDeepStrictEqual(
        withoutKeys(expected as unknown as Record<string, unknown>, ["lifecycle", "operatorReviewed", "supersededBy", "updatedAt"]),
        withoutKeys(playbook as unknown as Record<string, unknown>, ["lifecycle", "operatorReviewed", "supersededBy", "updatedAt"]),
      )) throw new Error("procedural playbook immutable fields cannot change");
      if (expected.operatorReviewed && !playbook.operatorReviewed) {
        throw new Error("operator review cannot be revoked");
      }
      const transition = `${expected.lifecycle}->${playbook.lifecycle}`;
      if (!["candidate->promoted", "candidate->quarantined", "promoted->quarantined", "promoted->superseded"].includes(transition)) {
        throw new Error("procedural playbook lifecycle transition is unsupported");
      }
      if (playbook.lifecycle === "promoted" && !playbook.operatorReviewed) {
        const episodes = this.listEpisodes(playbook.evidenceEpisodeIds);
        const verifiedRuns = new Set(episodes
          .filter((episode) => episode.outcome === "success" && episode.parentVerification === "parent_verified")
          .map((episode) => episode.runId));
        if (verifiedRuns.size < 2) throw new Error("playbook promotion requires repeated verified runs");
      }
      if (playbook.lifecycle === "superseded") {
        const successor = playbook.supersededBy ? this.getPlaybook(playbook.supersededBy) : null;
        if (!successor || successor.predecessorId !== playbook.playbookId) {
          throw new Error("superseded playbook requires a persisted successor");
        }
      }
      const result = db.prepare(`UPDATE procedural_playbooks_v2 SET
        version=?,lifecycle=?,operator_reviewed=?,superseded_by=?,payload_json=?,updated_at=?
        WHERE playbook_id=? AND version=? AND lifecycle=? AND operator_reviewed=? AND payload_json=?`).run(
        playbook.version, playbook.lifecycle, playbook.operatorReviewed ? 1 : 0, playbook.supersededBy ?? null,
        JSON.stringify(playbook), playbook.updatedAt, playbook.playbookId,
        expected.version, expected.lifecycle, expected.operatorReviewed ? 1 : 0, JSON.stringify(expected),
      );
      if (Number(result.changes) !== 1) throw new Error("procedural playbook compare-and-set failed");
      if (event) this.insertEvent(event);
    });
  }

  supersedePlaybook(
    expectedPrevious: ProceduralPlaybookV2,
    successor: ProceduralPlaybookV2,
    event: ExperienceEventV2,
  ): void {
    assertProceduralPlaybookSafeForPersistence(expectedPrevious);
    assertProceduralPlaybookSafeForPersistence(successor);
    assertExperienceEventSafeForPersistence(event);
    if (expectedPrevious.lifecycle !== "promoted") {
      throw new Error("only promoted playbooks can be superseded");
    }
    if (successor.lifecycle !== "candidate" || successor.operatorReviewed
      || successor.predecessorId !== expectedPrevious.playbookId
      || successor.supersededBy != null
      || successor.version !== expectedPrevious.version + 1) {
      throw new Error("procedural playbook successor boundary is invalid");
    }
    if (!isDeepStrictEqual(
      withoutKeys(expectedPrevious as unknown as Record<string, unknown>, [
        "playbookId", "version", "steps", "verificationGates", "lifecycle",
        "operatorReviewed", "predecessorId", "supersededBy", "createdAt", "updatedAt",
      ]),
      withoutKeys(successor as unknown as Record<string, unknown>, [
        "playbookId", "version", "steps", "verificationGates", "lifecycle",
        "operatorReviewed", "predecessorId", "supersededBy", "createdAt", "updatedAt",
      ]),
    )) {
      throw new Error("procedural playbook successor immutable fields changed");
    }
    if (event.entityType !== "playbook"
      || event.entityId !== expectedPrevious.playbookId
      || event.eventType !== "playbook_superseded"
      || event.createdAt !== successor.createdAt) {
      throw new Error("procedural playbook supersede event boundary is invalid");
    }

    const supersededPrevious: ProceduralPlaybookV2 = {
      ...expectedPrevious,
      lifecycle: "superseded",
      supersededBy: successor.playbookId,
      updatedAt: successor.createdAt,
    };
    assertProceduralPlaybookSafeForPersistence(supersededPrevious);
    const db = this.requireDb();
    this.transaction(() => {
      const current = this.getPlaybook(expectedPrevious.playbookId);
      if (!current || !isPersistedJsonEqual(current, expectedPrevious)) {
        const storedSuccessor = this.getPlaybook(successor.playbookId);
        const storedEvent = db.prepare(
          "SELECT entity_type,entity_id,event_type,actor,reason,created_at FROM experience_events_v2 WHERE event_id=?",
        ).get(event.eventId) as Record<string, unknown> | undefined;
        const replayedEvent = storedEvent ? {
          eventId: event.eventId,
          entityType: String(storedEvent.entity_type),
          entityId: String(storedEvent.entity_id),
          eventType: String(storedEvent.event_type),
          actor: String(storedEvent.actor),
          reason: String(storedEvent.reason),
          createdAt: String(storedEvent.created_at),
        } : null;
        if (current && isPersistedJsonEqual(current, supersededPrevious)
          && storedSuccessor && isPersistedJsonEqual(storedSuccessor, successor)
          && replayedEvent && isPersistedJsonEqual(replayedEvent, event)) {
          return;
        }
        throw new Error("procedural playbook supersede compare-and-set expected state is stale");
      }

      this.assertPlaybookEvidence(successor);
      this.insertPlaybook(successor);
      const result = db.prepare(`UPDATE procedural_playbooks_v2 SET
        lifecycle=?,superseded_by=?,payload_json=?,updated_at=?
        WHERE playbook_id=? AND version=? AND lifecycle=? AND operator_reviewed=? AND payload_json=?`).run(
        supersededPrevious.lifecycle, supersededPrevious.supersededBy,
        JSON.stringify(supersededPrevious), supersededPrevious.updatedAt,
        expectedPrevious.playbookId, expectedPrevious.version, expectedPrevious.lifecycle,
        expectedPrevious.operatorReviewed ? 1 : 0, JSON.stringify(expectedPrevious),
      );
      if (Number(result.changes) !== 1) {
        throw new Error("procedural playbook supersede compare-and-set failed");
      }
      this.insertEvent(event);
    });
  }

  appendEvent(event: ExperienceEventV2): void {
    assertExperienceEventSafeForPersistence(event);
    this.insertEvent(event);
  }

  private assertLinkedEvent(
    event: ExperienceEventV2,
    entityType: ExperienceEventV2["entityType"],
    entityId: string,
  ): void {
    assertExperienceEventSafeForPersistence(event);
    if (event.entityType !== entityType || event.entityId !== entityId) {
      throw new Error("experience mutation event does not match its entity boundary");
    }
  }

  private assertPlaybookEvidence(playbook: ProceduralPlaybookV2): void {
    const episodes = this.listEpisodes(playbook.evidenceEpisodeIds);
    if (episodes.length === 0 || episodes.length !== playbook.evidenceEpisodeIds.length
      || episodes.some((episode) => episode.outcome !== "success"
        || episode.parentVerification !== "parent_verified"
        || episode.lifecycle !== "candidate"
        || episode.taskClass !== playbook.taskClass
        || memoryAddressKey(episode.actorAddress) !== memoryAddressKey(playbook.scopeAddress))) {
      throw new Error("playbook persistence requires matching parent-verified evidence");
    }
  }

  private insertPlaybook(playbook: ProceduralPlaybookV2): void {
    this.requireDb().prepare(`INSERT INTO procedural_playbooks_v2
      (playbook_id,version,task_class,lifecycle,operator_reviewed,predecessor_id,
       superseded_by,payload_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      playbook.playbookId, playbook.version, playbook.taskClass, playbook.lifecycle,
      playbook.operatorReviewed ? 1 : 0, playbook.predecessorId ?? null,
      playbook.supersededBy ?? null, JSON.stringify(playbook), playbook.createdAt, playbook.updatedAt,
    );
  }

  private insertEvent(event: ExperienceEventV2): void {
    this.requireDb().prepare(`INSERT INTO experience_events_v2
      (event_id,entity_type,entity_id,event_type,actor,reason,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      event.eventId, event.entityType, event.entityId, event.eventType,
      event.actor, event.reason, event.createdAt,
    );
  }

  private ensureSchema(): void {
    this.requireDb().exec(EXPERIENCE_V2_SCHEMA_SQL);
  }

  private transaction<T>(action: () => T): T {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original mutation error */ }
      throw error;
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error("experience store is not open");
    return this.db;
  }
}
