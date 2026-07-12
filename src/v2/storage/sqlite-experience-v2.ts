import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { ExperienceStoreV2Port } from "../application/ports/experience-store.js";
import type {
  ChildScratchV2,
  ExperienceEpisodeV2,
  ExperienceEventV2,
  ProceduralPlaybookV2,
  SubagentSnapshotV2,
} from "../domain/experience.js";

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

export class SqliteExperienceStoreV2 implements ExperienceStoreV2Port {
  private db: DatabaseSync | null = null;

  constructor(private readonly path: string) {}

  open(): void {
    if (this.db) return;
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.ensureSchema();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  saveSnapshot(snapshot: SubagentSnapshotV2): void {
    this.requireDb().prepare(`INSERT INTO subagent_snapshots_v2
      (snapshot_id,parent_session_id,child_session_id,run_id,mode,status,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      snapshot.snapshotId, snapshot.parentSessionId, snapshot.childSessionId,
      snapshot.runId, snapshot.mode, snapshot.status, JSON.stringify(snapshot), snapshot.createdAt,
    );
  }

  getSnapshot(snapshotId: string): SubagentSnapshotV2 | null {
    const row = this.requireDb().prepare("SELECT payload_json FROM subagent_snapshots_v2 WHERE snapshot_id=?")
      .get(snapshotId) as Record<string, unknown> | undefined;
    return row ? parseJson<SubagentSnapshotV2>(row.payload_json) : null;
  }

  saveScratch(scratch: ChildScratchV2): void {
    this.requireDb().prepare(`INSERT INTO subagent_scratch_v2
      (scratch_id,snapshot_id,child_session_id,retention,lifecycle,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      scratch.scratchId, scratch.snapshotId, scratch.childSessionId, scratch.retention,
      scratch.lifecycle, JSON.stringify(scratch), scratch.createdAt,
    );
  }

  finalizeSnapshot(snapshot: SubagentSnapshotV2, episode: ExperienceEpisodeV2): void {
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

  updateEpisode(episode: ExperienceEpisodeV2): void {
    const result = this.requireDb().prepare(`UPDATE experience_episodes_v2 SET
      parent_verification=?,lifecycle=?,payload_json=?,updated_at=? WHERE episode_id=?`).run(
      episode.parentVerification, episode.lifecycle, JSON.stringify(episode), episode.updatedAt, episode.episodeId,
    );
    if (Number(result.changes) !== 1) throw new Error("experience episode update target missing");
  }

  listEpisodes(episodeIds: string[]): ExperienceEpisodeV2[] {
    if (episodeIds.length === 0) return [];
    const placeholders = episodeIds.map(() => "?").join(",");
    const rows = this.requireDb().prepare(`SELECT payload_json FROM experience_episodes_v2
      WHERE episode_id IN (${placeholders})`).all(...episodeIds) as Array<Record<string, unknown>>;
    return rows.map((row) => parseJson<ExperienceEpisodeV2>(row.payload_json));
  }

  savePlaybook(playbook: ProceduralPlaybookV2): void {
    this.requireDb().prepare(`INSERT INTO procedural_playbooks_v2
      (playbook_id,version,task_class,lifecycle,operator_reviewed,predecessor_id,
       superseded_by,payload_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      playbook.playbookId, playbook.version, playbook.taskClass, playbook.lifecycle,
      playbook.operatorReviewed ? 1 : 0, playbook.predecessorId ?? null,
      playbook.supersededBy ?? null, JSON.stringify(playbook), playbook.createdAt, playbook.updatedAt,
    );
  }

  getPlaybook(playbookId: string): ProceduralPlaybookV2 | null {
    const row = this.requireDb().prepare("SELECT payload_json FROM procedural_playbooks_v2 WHERE playbook_id=?")
      .get(playbookId) as Record<string, unknown> | undefined;
    return row ? parseJson<ProceduralPlaybookV2>(row.payload_json) : null;
  }

  updatePlaybook(playbook: ProceduralPlaybookV2): void {
    const result = this.requireDb().prepare(`UPDATE procedural_playbooks_v2 SET
      lifecycle=?,operator_reviewed=?,superseded_by=?,payload_json=?,updated_at=? WHERE playbook_id=?`).run(
      playbook.lifecycle, playbook.operatorReviewed ? 1 : 0, playbook.supersededBy ?? null,
      JSON.stringify(playbook), playbook.updatedAt, playbook.playbookId,
    );
    if (Number(result.changes) !== 1) throw new Error("procedural playbook update target missing");
  }

  appendEvent(event: ExperienceEventV2): void {
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

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error("experience store is not open");
    return this.db;
  }
}
