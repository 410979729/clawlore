#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createVerifiedLegacySqliteSnapshotV2,
  inspectLegacySqliteSnapshotV2,
} = jiti("../src/v2/operator/legacy-v1-snapshot.ts");
const { planLegacyMigrationV2 } = jiti("../src/v2/migration/legacy-v2-migration.ts");
const { previewLegacyMigrationV2 } = jiti("../src/v2/migration/legacy-v2-preview.ts");
const { previewLegacySessionAttributionV2 } = jiti("../src/v2/migration/legacy-session-attribution-preview.ts");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  for (const required of ["source", "receipt", "tenant", "agent"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

function opaquePath(path) {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 20);
}

const args = parseArgs(process.argv.slice(2));
const sourcePath = resolve(args.source);
const receiptPath = resolve(args.receipt);
const root = await mkdtemp(join(tmpdir(), "clawlore-live-preflight-"));
await chmod(root, 0o700);
const snapshotPath = join(root, "legacy-snapshot.sqlite3");

try {
  const sourceBefore = await inspectLegacySqliteSnapshotV2(sourcePath);
  const snapshot = await createVerifiedLegacySqliteSnapshotV2({ sourcePath, destinationPath: snapshotPath });
  const plan = planLegacyMigrationV2({
    legacyPath: snapshotPath,
    defaults: { tenantId: args.tenant, agentId: args.agent, workspaceId: args.workspace },
  });
  const debtPreview = previewLegacyMigrationV2(snapshotPath);
  const sessionAttribution = args["sessions-registry"]
    ? previewLegacySessionAttributionV2({
      legacyPath: snapshotPath,
      sessionsRegistryPath: resolve(args["sessions-registry"]),
    })
    : null;
  const sourceAfter = await inspectLegacySqliteSnapshotV2(sourcePath);
  const sourceStableDuringPreview = sourceBefore.memoryTruth.rowCount === sourceAfter.memoryTruth.rowCount
    && sourceBefore.memoryTruth.logicalDigest === sourceAfter.memoryTruth.logicalDigest
    && sourceBefore.schemaDigest === sourceAfter.schemaDigest;
  if (!sourceStableDuringPreview) {
    throw new Error("live legacy truth changed during preflight; retry from a quiet window");
  }

  const receipt = {
    schemaVersion: 1,
    phase: "clawlore-v2-live-migration-preflight",
    createdAt: new Date().toISOString(),
    status: "pass",
    readOnly: true,
    authorizesV2Writes: false,
    sourceRef: opaquePath(sourcePath),
    sourceStableDuringPreview,
    temporaryPlaintextRemoved: true,
    snapshot: {
      sha256: snapshot.sha256,
      bytes: snapshot.bytes,
      integrity: snapshot.integrity,
      foreignKeyViolations: snapshot.foreignKeyViolations,
      tableCount: snapshot.tableCount,
      schemaDigest: snapshot.schemaDigest,
      memoryTruthRows: snapshot.memoryTruth.rowCount,
      memoryTruthLogicalDigest: snapshot.memoryTruth.logicalDigest,
    },
    migration: {
      planDigest: plan.planDigest,
      totalRows: plan.totalRows,
      activeRows: plan.activeRows,
      candidateRows: plan.candidateRows,
      archivedRows: plan.archivedRows,
      reviewRequiredRows: plan.rows.filter((row) => row.reviewRequired).length,
      unverifiedRows: plan.rows.filter((row) => row.verification === "unverified").length,
      classifications: debtPreview.classifications,
      verificationDebtRows: debtPreview.verificationDebt,
      invalidMetadataRows: debtPreview.invalidMetadataRows,
      attributionLanes: debtPreview.attributionLanes,
      verificationDebtKinds: Object.fromEntries(
        [...new Set(plan.rows.map((row) => row.verificationDebt))]
          .sort()
          .map((kind) => [kind, plan.rows.filter((row) => row.verificationDebt === kind).length]),
      ),
      sessionAttribution,
    },
    nextGate: "encrypted_live_snapshot_and_separate_v2_write_approval",
  };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(receiptPath, 0o600);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
