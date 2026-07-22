import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { MemoryStore } = jiti("../src/store.ts");
const { VectorScopeMetadataUpdater } = jiti("../src/vector-scope-metadata-updater.ts");
const { SqliteTruthStoreV2 } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const { resolvePrincipalWriteTarget } = jiti("../src/principal-write-boundary.ts");
const { inspectLegacySqliteSnapshotV2 } = jiti("../src/v2/operator/legacy-v1-snapshot.ts");
const { createLivePrincipalScopePlanV1 } = jiti("../src/v2/operator/live-principal-scope-plan.ts");
const { executeLivePrincipalScopeApplyV1 } = jiti("../src/v2/operator/live-principal-scope-apply.ts");
const { finalizeLivePrincipalScopeVectorsV1 } =
  jiti("../src/v2/operator/live-principal-scope-vector-finalize.ts");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("principal-scope apply is snapshot-bound, transactional, vector-convergent, and idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-principal-apply-"));
  const dbDir = join(root, "memory");
  const sqlitePath = join(dbDir, "memory.sqlite3");
  const planPath = join(root, "plan.json");
  const archivePath = join(root, "snapshot.clawlore2");
  const snapshotReceiptPath = join(root, "snapshot.receipt.json");
  const sessionKey = "agent:main:telegram:default:direct:owner";
  const sourceScope = "agent:main";
  const targetScope = resolvePrincipalWriteTarget({ sessionKey }).scope;
  const migrationId = "principal-scope-owner-apply-r1";
  const now = new Date("2026-07-22T00:00:00.000Z");
  const targetA = "00000000-0000-4000-8000-000000000001";
  const targetB = "00000000-0000-4000-8000-000000000002";
  const targetAlready = "00000000-0000-4000-8000-000000000003";
  let store;
  let scopeUpdater;
  try {
    store = new MemoryStore({ dbPath: dbDir, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
    for (const [id, scope, field] of [
      [targetA, sourceScope, "sessionKey"],
      [targetB, sourceScope, "source_session"],
      [targetAlready, targetScope, "session_key"],
    ]) {
      await store.importEntry({
        id,
        text: `durable fact ${id}`,
        vector: [id.length, 1, 0, 0],
        category: "fact",
        scope,
        importance: 0.8,
        timestamp: 1_700_000_000_000,
        metadata: JSON.stringify({ [field]: sessionKey }),
      });
    }
    await store.close();
    store = undefined;

    let sequence = 0;
    const clock = {
      now: () => now,
      id: () => `fixture-${++sequence}`,
    };
    const v2 = new SqliteTruthStoreV2(sqlitePath, clock);
    v2.open();
    for (const id of [targetA, targetB, targetAlready]) {
      const principalId = "legacy:unresolved";
      v2.remember({
        itemId: `legacy:${id}`,
        content: `durable fact ${id}`,
        category: "fact",
        address: {
          schemaVersion: 2,
          tenantId: "local",
          principalId,
          agentId: "main",
          visibility: "private",
          retention: "durable",
        },
        lifecycle: "candidate",
        verification: "unverified",
        source: {
          sourceType: "legacy",
          sourceId: id,
          observedAt: now.toISOString(),
          evidence: {},
        },
        actor: "operator:fixture",
        reason: "principal scope integration fixture",
      });
    }
    v2.close();

    const plan = await createLivePrincipalScopePlanV1({
      sourcePath: sqlitePath,
      targetSessionKey: sessionKey,
      sourceScope,
      proposedMigrationId: migrationId,
      now: () => now,
    });
    assert.equal(plan.summary.migrationEligibleRows, 2);
    assert.equal(plan.summary.principalAssignmentRows, 3);
    assert.equal(plan.summary.alreadyAssignedRows, 1);
    assert.equal(plan.decision.assignmentReady, true);
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    await chmod(planPath, 0o600);

    const snapshot = await inspectLegacySqliteSnapshotV2(sqlitePath, now.toISOString());
    const archiveBytes = Buffer.from("synthetic encrypted snapshot archive");
    await writeFile(archivePath, archiveBytes, { mode: 0o600 });
    await chmod(archivePath, 0o600);
    await writeFile(snapshotReceiptPath, `${JSON.stringify({
      schemaVersion: 1,
      phase: "clawlore-v2-live-encrypted-snapshot",
      createdAt: now.toISOString(),
      status: "pass",
      authorizesV2Writes: false,
      archiveSha256: sha256(archiveBytes),
      sourceStableDuringBackup: true,
      restoreVerified: true,
      restoredPlaintextRemoved: true,
      snapshot: {
        schemaDigest: snapshot.schemaDigest,
        memoryTruthRows: snapshot.memoryTruth.rowCount,
        memoryTruthLogicalDigest: snapshot.memoryTruth.logicalDigest,
        integrity: "ok",
        foreignKeyViolations: 0,
      },
    }, null, 2)}\n`, { mode: 0o600 });
    await chmod(snapshotReceiptPath, 0o600);

    let eventSequence = 0;
    const applied = await executeLivePrincipalScopeApplyV1({
      sourcePath: sqlitePath,
      targetSessionKey: sessionKey,
      sourceScope,
      planPath,
      snapshotArchivePath: archivePath,
      snapshotReceiptPath,
      migrationId,
      planDigest: plan.planDigest,
      now: () => now,
      id: () => `principal-event-${++eventSequence}`,
    });
    assert.equal(applied.status, "truth_applied_vector_pending");
    assert.equal(applied.idempotentReplay, false);
    assert.equal(applied.mutation.v1ScopeRowsChanged, 2);
    assert.equal(applied.mutation.v2AddressRowsChanged, 3);
    assert.equal(applied.mutation.aclRowsChanged, 3);
    assert.equal(applied.mutation.sourceEvidenceRowsChanged, 3);
    assert.equal(applied.mutation.vectorRepairRowsPending, 2);

    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_truth WHERE scope=?").get(targetScope).n, 3);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_lifecycle_projection
      WHERE scope=?`).get(targetScope).n, 3);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_items
      WHERE principal_id='telegram:default:owner'`).get().n, 3);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_acl
      WHERE owner_principal_id='telegram:default:owner'`).get().n, 3);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_sources
      WHERE json_extract(evidence_json,'$.principalScopeAssignmentV1.migrationId')=?`)
      .get(migrationId).n, 3);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM vector_companion_repair_outbox
      WHERE operation='principal-scope-assignment'`).get().n, 2);
    db.close();

    store = new MemoryStore({ dbPath: dbDir, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
    scopeUpdater = new VectorScopeMetadataUpdater({
      dbPath: dbDir, vectorDim: 4, vectorBackend: "sqlite-bruteforce",
    });
    const finalized = await finalizeLivePrincipalScopeVectorsV1({
      store,
      scopeUpdater,
      migrationId,
      expectedPlanDigest: plan.planDigest,
      now: () => new Date("2026-07-22T00:01:00.000Z"),
    });
    assert.equal(finalized.status, "complete");
    assert.equal(finalized.vectorScopeRowsChanged, 2);
    assert.equal(finalized.vectorsReconciledThisRun, 2);
    assert.equal(finalized.pendingRepairRows, 0);
    assert.equal((await store.getVectorEntryById(targetA)).scope, targetScope);
    assert.equal((await store.getVectorEntryById(targetB)).scope, targetScope);

    const replay = await executeLivePrincipalScopeApplyV1({
      sourcePath: sqlitePath,
      targetSessionKey: sessionKey,
      sourceScope,
      planPath,
      snapshotArchivePath: archivePath,
      snapshotReceiptPath,
      migrationId,
      planDigest: plan.planDigest,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    assert.equal(replay.status, "complete");
    assert.equal(replay.idempotentReplay, true);
    const finalizeReplay = await finalizeLivePrincipalScopeVectorsV1({
      store,
      scopeUpdater,
      migrationId,
      expectedPlanDigest: plan.planDigest,
    });
    assert.equal(finalizeReplay.idempotentReplay, true);
    assert.equal(finalizeReplay.vectorScopeRowsChanged, 2);
    assert.equal(finalizeReplay.vectorsReconciledThisRun, 0);
  } finally {
    try { await scopeUpdater?.close(); } finally {
      try { await store?.close(); } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
