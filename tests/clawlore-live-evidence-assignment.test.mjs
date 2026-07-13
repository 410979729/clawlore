import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { TRUTH_V2_SCHEMA_SQL } = jiti("../src/v2/storage/sqlite-truth-v2.ts");
const { inspectLegacySqliteSnapshotV2 } = jiti("../src/v2/operator/legacy-v1-snapshot.ts");
const { createLiveCandidateEvidenceRemediationPlanV1 } =
  jiti("../src/v2/operator/live-candidate-evidence-remediation.ts");
const { createLiveEvidenceAssignmentPlanV1 } =
  jiti("../src/v2/operator/live-evidence-assignment-plan.ts");
const { executeLiveEvidenceAssignmentV1 } =
  jiti("../src/v2/operator/live-evidence-assignment-apply.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function privateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-evidence-apply-"));
  const source = join(root, "live.sqlite3");
  const registry = join(root, "sessions.json");
  const baseline = join(root, "baseline.json");
  const remediation = join(root, "remediation.json");
  const planPath = join(root, "plan.json");
  const snapshotArchive = join(root, "fresh.clawlore2");
  const snapshotReceipt = join(root, "snapshot.json");
  const rolloutId = "clawlore-v2-evidence-assignment-fixture-r1";
  const direct = "agent:main:telegram:default:direct:user-1";
  const group = "agent:main:telegram:group:group-1";
  const rows = [
    ["direct", { source: "auto-capture", sessionKey: direct }, "auto_capture", "unverified"],
    ["group", { source: "auto-capture", sessionKey: group }, "auto_capture", "unverified"],
    ["manual", { source: "manual" }, "explicit_manual", "user_confirmed"],
    ["system", { source: "reflection-summary", source_session: "batch-1" }, "reflection_summary", "unverified"],
    ["alias", { source: "auto-capture", source_session: "agent:main:main" }, "auto_capture", "unverified"],
    ["opaque", { source: "auto-capture", source_session: "opaque" }, "auto_capture", "unverified"],
    ["unknown", {}, "unknown_legacy", "unverified"],
  ];
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(
      id TEXT PRIMARY KEY,text TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,
      timestamp REAL NOT NULL,metadata TEXT NOT NULL,metadata_text TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,text,metadata_text);
    ${TRUTH_V2_SCHEMA_SQL}
    CREATE TABLE memory_fts_compat_v2(item_id TEXT PRIMARY KEY);`);
  const now = "2026-07-12T14:00:00.000Z";
  for (const [id, metadata, classification, verification] of rows) {
    const itemId = `legacy:${id}`;
    const revisionId = `revision:${id}`;
    const address = {
      schemaVersion: 2,
      tenantId: "tenant",
      principalId: "legacy:unresolved",
      agentId: "main",
      visibility: "private",
      retention: "durable",
    };
    db.prepare("INSERT INTO memory_truth VALUES (?,?,?,?,?,?,?)")
      .run(id, `memory ${id}`, "other", "agent:main", Date.parse(now), JSON.stringify(metadata), "");
    db.prepare("INSERT INTO memory_fts VALUES (?,?,?)").run(id, `memory ${id}`, "");
    db.prepare(`INSERT INTO memory_revisions
      (revision_id,item_id,revision_no,content,lifecycle,verification,valid_until,created_at)
      VALUES (?,?,1,?,'candidate',?,NULL,?)`).run(revisionId, itemId, `memory ${id}`, verification, now);
    db.prepare(`INSERT INTO memory_items
      (item_id,current_revision_id,revision_no,content,category,address_json,tenant_id,principal_id,agent_id,
       visibility,retention,lifecycle,verification,created_at,updated_at)
      VALUES (?,?,1,?,'other',?,'tenant','legacy:unresolved','main','private','durable','candidate',?,?,?)`)
      .run(itemId, revisionId, `memory ${id}`, JSON.stringify(address), verification, now, now);
    db.prepare(`INSERT INTO memory_sources
      (source_id,revision_id,source_type,external_id,observed_at,evidence_json) VALUES (?,?,?,?,?,?)`)
      .run(`source:${id}`, revisionId, "legacy", id, now, JSON.stringify({ classification, original: true }));
    db.prepare("INSERT INTO memory_fts_compat_v2 VALUES (?)").run(itemId);
  }
  db.close();
  await chmod(source, 0o600);
  const registryValue = {
    [direct]: { sessionId: "direct-id", sessionFile: join(root, "direct-id.jsonl") },
    [group]: { sessionId: "group-id", sessionFile: join(root, "group-id.jsonl") },
  };
  await privateJson(registry, registryValue);
  await privateJson(baseline, {
    phase: "clawlore-phase7g-live-preview",
    candidatePromotionPlan: {
      planDigest: sha256("baseline"),
      rows: rows.map(([id]) => ({ itemIdSha256: sha256(`legacy:${id}`) })),
      authorizesLiveMutation: false,
    },
  });
  const remediationValue = createLiveCandidateEvidenceRemediationPlanV1({
    sourcePath: source,
    sessionsRegistryPath: registry,
    baselinePreviewPath: baseline,
  });
  await privateJson(remediation, remediationValue);
  const plan = createLiveEvidenceAssignmentPlanV1({
    sourcePath: source,
    sessionsRegistryPath: registry,
    remediationPreviewPath: remediation,
    baselinePromotionPreviewPath: baseline,
    proposedRolloutId: rolloutId,
  });
  await privateJson(planPath, plan);
  const snapshot = await inspectLegacySqliteSnapshotV2(source, "2026-07-12T14:02:00.000Z");
  await writeFile(snapshotArchive, Buffer.from("fixture encrypted archive"), { mode: 0o600 });
  await chmod(snapshotArchive, 0o600);
  const archiveBytes = await readFile(snapshotArchive);
  await privateJson(snapshotReceipt, {
    schemaVersion: 1,
    phase: "clawlore-v2-live-encrypted-snapshot",
    createdAt: "2026-07-12T14:02:00.000Z",
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
  });
  return {
    root, source, registry, registryValue, baseline, remediation, planPath,
    snapshotArchive, snapshotReceipt, rolloutId, plan,
  };
}

function execute(paths) {
  return executeLiveEvidenceAssignmentV1({
    sourcePath: paths.source,
    sessionsRegistryPath: paths.registry,
    remediationPreviewPath: paths.remediation,
    baselinePromotionPreviewPath: paths.baseline,
    planPath: paths.planPath,
    snapshotArchivePath: paths.snapshotArchive,
    snapshotReceiptPath: paths.snapshotReceipt,
    rolloutId: paths.rolloutId,
    planDigest: paths.plan.planDigest,
    now: () => new Date("2026-07-12T14:03:00.000Z"),
  });
}

test("evidence assignment writes only exact registry-resolved source evidence", async () => {
  const paths = await fixture();
  try {
    await privateJson(paths.registry, {
      ...paths.registryValue,
      "agent:main:telegram:default:direct:unrelated": { sessionId: "new-unrelated" },
    });
    const receipt = await execute(paths);
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.evidence.rowsWritten, 2);
    assert.equal(receipt.evidence.directPrincipalRows, 1);
    assert.equal(receipt.evidence.conversationBoundaryRows, 1);
    assert.equal(receipt.evidence.nonTargetEvidenceRowsChanged, 0);
    assert.equal(receipt.canonical.lifecycleRowsChanged, 0);
    assert.equal(receipt.canonical.verificationRowsChanged, 0);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    const rows = db.prepare(`SELECT i.item_id,i.lifecycle,i.verification,s.evidence_json
      FROM memory_items i JOIN memory_sources s ON s.revision_id=i.current_revision_id ORDER BY i.item_id`).all();
    const assigned = rows.filter((row) => JSON.parse(row.evidence_json).registryResolvedEvidenceV1);
    assert.equal(assigned.length, 2);
    assert.deepEqual(assigned.map((row) => row.item_id), ["legacy:direct", "legacy:group"]);
    assert.equal(rows.every((row) => row.lifecycle === "candidate"), true);
    assert.equal(JSON.parse(rows.find((row) => row.item_id === "legacy:manual").evidence_json).original, true);
    db.close();
    await assert.rejects(() => execute(paths), /already exists/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("evidence assignment rejects target registry drift before any write", async () => {
  const paths = await fixture();
  try {
    const changed = { ...paths.registryValue };
    delete changed[Object.keys(changed)[0]];
    await privateJson(paths.registry, changed);
    await assert.rejects(() => execute(paths), /no longer matches|rows no longer match|target evidence/);
    const db = new DatabaseSync(paths.source, { readOnly: true });
    const rows = db.prepare("SELECT evidence_json FROM memory_sources").all();
    assert.equal(rows.some((row) => JSON.parse(row.evidence_json).registryResolvedEvidenceV1), false);
    db.close();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
