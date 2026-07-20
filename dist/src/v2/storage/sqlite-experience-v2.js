import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { enforcePrivatePath, ensurePrivateDirectory } from "../../file-privacy.js";
import { assertChildScratchSafeForPersistence, assertExperienceEpisodeSafeForPersistence, assertExperienceEventSafeForPersistence, assertProceduralPlaybookSafeForPersistence, assertSubagentSnapshotSafeForPersistence, } from "../domain/experience-write-policy.js";
import { memoryAddressKey } from "../domain/memory-address.js";
const require = createRequire(import.meta.url);
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
function parseJson(value) {
    return JSON.parse(String(value));
}
function withoutKeys(value, keys) {
    const omitted = new Set(keys);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}
function enforcePrivateSqliteFamily(path) {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(candidate))
            enforcePrivatePath(candidate, { kind: "file" });
    }
}
export class SqliteExperienceStoreV2 {
    path;
    db = null;
    constructor(path) {
        this.path = path;
    }
    open() {
        if (this.db)
            return;
        const { DatabaseSync } = require("node:sqlite");
        ensurePrivateDirectory(dirname(this.path));
        enforcePrivateSqliteFamily(this.path);
        this.db = new DatabaseSync(this.path);
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        this.ensureSchema();
        enforcePrivateSqliteFamily(this.path);
    }
    close() {
        this.db?.close();
        this.db = null;
        enforcePrivateSqliteFamily(this.path);
    }
    saveSnapshot(snapshot) {
        assertSubagentSnapshotSafeForPersistence(snapshot);
        if (snapshot.status !== "active")
            throw new Error("new subagent snapshot must be active");
        this.requireDb().prepare(`INSERT INTO subagent_snapshots_v2
      (snapshot_id,parent_session_id,child_session_id,run_id,mode,status,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(snapshot.snapshotId, snapshot.parentSessionId, snapshot.childSessionId, snapshot.runId, snapshot.mode, snapshot.status, JSON.stringify(snapshot), snapshot.createdAt);
    }
    getSnapshot(snapshotId) {
        const row = this.requireDb().prepare("SELECT payload_json FROM subagent_snapshots_v2 WHERE snapshot_id=?")
            .get(snapshotId);
        return row ? parseJson(row.payload_json) : null;
    }
    saveScratch(scratch) {
        assertChildScratchSafeForPersistence(scratch);
        const snapshot = this.getSnapshot(scratch.snapshotId);
        if (!snapshot || snapshot.status !== "active" || snapshot.childSessionId !== scratch.childSessionId) {
            throw new Error("active child-owned snapshot is required for scratch persistence");
        }
        this.requireDb().prepare(`INSERT INTO subagent_scratch_v2
      (scratch_id,snapshot_id,child_session_id,retention,lifecycle,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(scratch.scratchId, scratch.snapshotId, scratch.childSessionId, scratch.retention, scratch.lifecycle, JSON.stringify(scratch), scratch.createdAt);
    }
    finalizeSnapshot(snapshot, episode) {
        assertSubagentSnapshotSafeForPersistence(snapshot);
        assertExperienceEpisodeSafeForPersistence(episode);
        const current = this.getSnapshot(snapshot.snapshotId);
        if (!current || current.status !== "active" || snapshot.status !== "revoked") {
            throw new Error("active snapshot must transition to revoked");
        }
        if (!isDeepStrictEqual(withoutKeys(current, ["status"]), withoutKeys(snapshot, ["status"])))
            throw new Error("subagent snapshot immutable fields changed during finalization");
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
        SET status=?,payload_json=? WHERE snapshot_id=? AND status='active'`).run(snapshot.status, JSON.stringify(snapshot), snapshot.snapshotId);
            if (Number(result.changes) !== 1)
                throw new Error("active subagent snapshot finalization target missing");
            db.prepare(`INSERT INTO experience_episodes_v2
        (episode_id,snapshot_id,parent_session_id,child_session_id,run_id,task_class,outcome,
         parent_verification,lifecycle,payload_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(episode.episodeId, episode.snapshotId, episode.parentSessionId, episode.childSessionId, episode.runId, episode.taskClass, episode.outcome, episode.parentVerification, episode.lifecycle, JSON.stringify(episode), episode.createdAt, episode.updatedAt);
            db.exec("COMMIT");
        }
        catch (error) {
            try {
                db.exec("ROLLBACK");
            }
            catch { /* preserve original error */ }
            throw error;
        }
    }
    getEpisode(episodeId) {
        const row = this.requireDb().prepare("SELECT payload_json FROM experience_episodes_v2 WHERE episode_id=?")
            .get(episodeId);
        return row ? parseJson(row.payload_json) : null;
    }
    updateEpisode(episode) {
        assertExperienceEpisodeSafeForPersistence(episode);
        const current = this.getEpisode(episode.episodeId);
        if (!current)
            throw new Error("experience episode update target missing");
        if (!isDeepStrictEqual(withoutKeys(current, ["parentVerification", "lifecycle", "verificationReason", "updatedAt"]), withoutKeys(episode, ["parentVerification", "lifecycle", "verificationReason", "updatedAt"])))
            throw new Error("experience episode immutable fields cannot change");
        if (current.parentVerification !== "pending" || current.lifecycle !== "candidate") {
            throw new Error("experience episode review is already terminal");
        }
        const result = this.requireDb().prepare(`UPDATE experience_episodes_v2 SET
      parent_verification=?,lifecycle=?,payload_json=?,updated_at=? WHERE episode_id=?`).run(episode.parentVerification, episode.lifecycle, JSON.stringify(episode), episode.updatedAt, episode.episodeId);
        if (Number(result.changes) !== 1)
            throw new Error("experience episode update target missing");
    }
    listEpisodes(episodeIds) {
        if (episodeIds.length === 0)
            return [];
        if (episodeIds.length > 256)
            throw new Error("episode lookup exceeds the size limit");
        const placeholders = episodeIds.map(() => "?").join(",");
        const rows = this.requireDb().prepare(`SELECT payload_json FROM experience_episodes_v2
      WHERE episode_id IN (${placeholders})`).all(...episodeIds);
        return rows.map((row) => parseJson(row.payload_json));
    }
    savePlaybook(playbook) {
        assertProceduralPlaybookSafeForPersistence(playbook);
        if (playbook.lifecycle !== "candidate" || playbook.operatorReviewed || playbook.supersededBy != null) {
            throw new Error("new procedural playbook must begin as an unreviewed candidate");
        }
        const episodes = this.listEpisodes(playbook.evidenceEpisodeIds);
        if (episodes.length === 0 || episodes.length !== playbook.evidenceEpisodeIds.length
            || episodes.some((episode) => episode.outcome !== "success"
                || episode.parentVerification !== "parent_verified"
                || episode.lifecycle !== "candidate"
                || episode.taskClass !== playbook.taskClass
                || memoryAddressKey(episode.actorAddress) !== memoryAddressKey(playbook.scopeAddress))) {
            throw new Error("playbook persistence requires matching parent-verified evidence");
        }
        this.requireDb().prepare(`INSERT INTO procedural_playbooks_v2
      (playbook_id,version,task_class,lifecycle,operator_reviewed,predecessor_id,
       superseded_by,payload_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(playbook.playbookId, playbook.version, playbook.taskClass, playbook.lifecycle, playbook.operatorReviewed ? 1 : 0, playbook.predecessorId ?? null, playbook.supersededBy ?? null, JSON.stringify(playbook), playbook.createdAt, playbook.updatedAt);
    }
    getPlaybook(playbookId) {
        const row = this.requireDb().prepare("SELECT payload_json FROM procedural_playbooks_v2 WHERE playbook_id=?")
            .get(playbookId);
        return row ? parseJson(row.payload_json) : null;
    }
    updatePlaybook(playbook) {
        assertProceduralPlaybookSafeForPersistence(playbook);
        const current = this.getPlaybook(playbook.playbookId);
        if (!current)
            throw new Error("procedural playbook update target missing");
        if (!isDeepStrictEqual(withoutKeys(current, ["lifecycle", "operatorReviewed", "supersededBy", "updatedAt"]), withoutKeys(playbook, ["lifecycle", "operatorReviewed", "supersededBy", "updatedAt"])))
            throw new Error("procedural playbook immutable fields cannot change");
        if (current.operatorReviewed && !playbook.operatorReviewed) {
            throw new Error("operator review cannot be revoked");
        }
        const transition = `${current.lifecycle}->${playbook.lifecycle}`;
        if (!["candidate->promoted", "candidate->quarantined", "promoted->quarantined", "promoted->superseded"].includes(transition)) {
            throw new Error("procedural playbook lifecycle transition is unsupported");
        }
        if (playbook.lifecycle === "promoted" && !playbook.operatorReviewed) {
            const episodes = this.listEpisodes(playbook.evidenceEpisodeIds);
            const verifiedRuns = new Set(episodes
                .filter((episode) => episode.outcome === "success" && episode.parentVerification === "parent_verified")
                .map((episode) => episode.runId));
            if (verifiedRuns.size < 2)
                throw new Error("playbook promotion requires repeated verified runs");
        }
        if (playbook.lifecycle === "superseded") {
            const successor = playbook.supersededBy ? this.getPlaybook(playbook.supersededBy) : null;
            if (!successor || successor.predecessorId !== playbook.playbookId) {
                throw new Error("superseded playbook requires a persisted successor");
            }
        }
        const result = this.requireDb().prepare(`UPDATE procedural_playbooks_v2 SET
      lifecycle=?,operator_reviewed=?,superseded_by=?,payload_json=?,updated_at=? WHERE playbook_id=?`).run(playbook.lifecycle, playbook.operatorReviewed ? 1 : 0, playbook.supersededBy ?? null, JSON.stringify(playbook), playbook.updatedAt, playbook.playbookId);
        if (Number(result.changes) !== 1)
            throw new Error("procedural playbook update target missing");
    }
    appendEvent(event) {
        assertExperienceEventSafeForPersistence(event);
        this.requireDb().prepare(`INSERT INTO experience_events_v2
      (event_id,entity_type,entity_id,event_type,actor,reason,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(event.eventId, event.entityType, event.entityId, event.eventType, event.actor, event.reason, event.createdAt);
    }
    ensureSchema() {
        this.requireDb().exec(EXPERIENCE_V2_SCHEMA_SQL);
    }
    requireDb() {
        if (!this.db)
            throw new Error("experience store is not open");
        return this.db;
    }
}
