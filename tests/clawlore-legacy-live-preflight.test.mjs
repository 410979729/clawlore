import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url);
const {
  createVerifiedLegacySqliteSnapshotV2,
  inspectLegacySqliteSnapshotV2,
  restoreVerifiedLegacySqliteSnapshotV2,
} = jiti("../src/v2/operator/legacy-v1-snapshot.ts");
const { planLegacyMigrationV2 } = jiti("../src/v2/migration/legacy-v2-migration.ts");
const { previewLegacyMigrationV2 } = jiti("../src/v2/migration/legacy-v2-preview.ts");
const { previewLegacySessionAttributionV2 } = jiti("../src/v2/migration/legacy-session-attribution-preview.ts");
const { previewLegacyManualReviewV2 } = jiti("../src/v2/migration/legacy-manual-review-preview.ts");

function createLegacy(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE memory_truth (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL,
      scope TEXT NOT NULL, timestamp INTEGER NOT NULL, metadata TEXT NOT NULL
    );`);
  return db;
}

function insert(db, id, text, metadata = {}) {
  db.prepare(`INSERT INTO memory_truth(id,text,category,scope,timestamp,metadata)
    VALUES(?,?,?,?,?,?)`).run(id, text, "fact", "agent:main", 1_783_000_000, JSON.stringify(metadata));
}

test("legacy live preflight snapshots WAL truth consistently and plans only from the copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-legacy-preflight-"));
  const sourcePath = join(root, "legacy.sqlite3");
  const snapshotPath = join(root, "snapshot.sqlite3");
  const restoredPath = join(root, "restored.sqlite3");
  const db = createLegacy(sourcePath);
  try {
    insert(db, "before", "Verified source fact", { source: "manual_user", senderId: "user-1" });
    const sourceBefore = await inspectLegacySqliteSnapshotV2(sourcePath);
    const snapshot = await createVerifiedLegacySqliteSnapshotV2({ sourcePath, destinationPath: snapshotPath });
    insert(db, "after", "Later write must not enter the point-in-time copy");

    assert.equal(snapshot.profile, "scope-recall-legacy-v1");
    assert.equal(snapshot.integrity, "ok");
    assert.equal(snapshot.memoryTruth.rowCount, 1);
    assert.equal(snapshot.memoryTruth.logicalDigest, sourceBefore.memoryTruth.logicalDigest);

    const plan = planLegacyMigrationV2({
      legacyPath: snapshotPath,
      defaults: { tenantId: "tenant-test", agentId: "agent-test", workspaceId: "workspace-test" },
    });
    assert.equal(plan.totalRows, 1);
    assert.equal(plan.rows.some((row) => row.legacyId === "after"), false);
    const debt = previewLegacyMigrationV2(snapshotPath);
    assert.deepEqual(debt.attributionLanes, { resolved_principal: 1 });

    const restored = await restoreVerifiedLegacySqliteSnapshotV2({
      snapshotPath, destinationPath: restoredPath, expected: snapshot,
    });
    assert.equal(restored.memoryTruth.logicalDigest, snapshot.memoryTruth.logicalDigest);
    assert.equal(restored.memoryTruth.rowCount, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy debt preview separates system, session, manual, and quarantine lanes", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-legacy-lanes-"));
  const path = join(root, "legacy.sqlite3");
  const db = createLegacy(path);
  try {
    insert(db, "digest", "Nightly digest", { source: "nightly_digest" });
    insert(db, "checkpoint", "Pressure checkpoint", { source: "session-pressure-guard" });
    insert(db, "session", "Captured session fact", { source: "auto-capture", source_session: "opaque-session" });
    insert(db, "resolved", "Runtime attributed fact", { source: "auto-capture", senderId: "user-1" });
    insert(db, "unknown", "Unknown legacy fact", {});
    const preview = previewLegacyMigrationV2(path);
    assert.deepEqual(preview.classifications, {
      operational_checkpoint: 1,
      reflection_summary: 1,
      auto_capture: 2,
      unknown_legacy: 1,
    });
    assert.deepEqual(preview.attributionLanes, {
      system_generated_review: 2,
      session_attribution_review: 1,
      resolved_principal: 1,
      unattributed_quarantine: 1,
    });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("session attribution preview trusts registry keys only and never reads transcript content", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-session-attribution-"));
  const path = join(root, "legacy.sqlite3");
  const registryPath = join(root, "sessions.json");
  const db = createLegacy(path);
  try {
    const direct = "agent:main:telegram:default:direct:user-1";
    const group = "agent:main:telegram:group:conversation-1";
    insert(db, "direct", "Direct-scoped fact", { sessionKey: direct });
    insert(db, "group", "Conversation-scoped fact", { sessionKey: group });
    insert(db, "direct-id", "Direct session-id fact", { sessionId: "direct-id" });
    insert(db, "group-file", "Group session-file fact", { source_session: "group-id.jsonl" });
    insert(db, "forged", "Unregistered session reference", { sessionKey: "agent:main:telegram:default:direct:unknown" });
    insert(db, "batch", "Batch reference", { source: "session-summary", source_session: "distillation-batch-1" });
    insert(db, "alias", "Legacy agent scope", { source: "auto-capture", source_session: "agent:main:main" });
    insert(db, "opaque", "Opaque capture reference", { source: "auto-capture", source_session: "unknown" });
    insert(db, "conflict", "Conflicting registry evidence", { sessionKey: direct, sessionId: "group-id" });
    insert(db, "none", "No session evidence", {});
    await writeFile(registryPath, JSON.stringify({
      [direct]: { sessionId: "direct-id", sessionFile: join(root, "direct-id.jsonl") },
      [group]: { sessionId: "group-id", sessionFile: join(root, "group-id.jsonl") },
    }), { mode: 0o600 });
    const preview = previewLegacySessionAttributionV2({
      legacyPath: path,
      sessionsRegistryPath: registryPath,
    });
    assert.deepEqual(preview.lanes, {
      trustedPrivatePrincipal: 2,
      trustedConversationBoundary: 2,
      trustedOtherSession: 0,
      conflictingRegistryEvidence: 1,
      unresolvedSessionReference: 1,
      legacyAgentScopeAlias: 1,
      derivedSystemReference: 1,
      opaqueUnverifiableReference: 1,
      noSessionReference: 1,
    });
    assert.deepEqual(preview.trustedEvidence, {
      registryKey: 2,
      registrySessionId: 1,
      registrySessionFile: 1,
    });
    assert.equal(preview.trustedCoverageRows, 4);
    assert.equal(preview.transcriptContentRead, false);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual review preview never auto-activates agent-scoped rows without identity evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-manual-review-"));
  const path = join(root, "legacy.sqlite3");
  const db = createLegacy(path);
  try {
    insert(db, "needs-operator", "Manual fact", { source: "manual", state: "confirmed" });
    insert(db, "archived", "Archived manual fact", { source: "manual", state: "archived" });
    insert(db, "attributed", "Attributed manual fact", { source: "manual_user", senderId: "user-1" });
    insert(db, "automatic", "Automatic fact", { source: "auto-capture" });
    const preview = previewLegacyManualReviewV2(path);
    assert.deepEqual(preview, {
      schemaVersion: 1,
      readOnly: true,
      contentRead: false,
      manualRows: 3,
      lanes: {
        metadataPrincipalEvidence: 1,
        preserveArchived: 1,
        operatorIdentityAssignment: 1,
        scopeReview: 0,
        invalidMetadata: 0,
      },
      automaticActivationRows: 0,
    });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy restore rejects a tampered snapshot before creating a destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-legacy-tamper-"));
  const sourcePath = join(root, "legacy.sqlite3");
  const snapshotPath = join(root, "snapshot.sqlite3");
  const destinationPath = join(root, "restored.sqlite3");
  const db = createLegacy(sourcePath);
  try {
    insert(db, "truth", "Tamper detection fixture");
    const snapshot = await createVerifiedLegacySqliteSnapshotV2({ sourcePath, destinationPath: snapshotPath });
    await appendFile(snapshotPath, "tamper");
    await assert.rejects(
      () => restoreVerifiedLegacySqliteSnapshotV2({ snapshotPath, destinationPath, expected: snapshot }),
      /checksum mismatch/,
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
