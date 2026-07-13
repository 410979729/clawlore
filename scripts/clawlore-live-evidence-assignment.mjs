#!/usr/bin/env node
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { executeLiveEvidenceAssignmentV1 } = jiti(
  "../src/v2/operator/live-evidence-assignment-apply.ts",
);

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
  for (const required of [
    "source", "sessions-registry", "remediation-preview", "baseline-preview", "plan",
    "snapshot-archive", "snapshot-receipt", "rollout-id", "plan-digest", "receipt",
  ]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const receipt = await executeLiveEvidenceAssignmentV1({
  sourcePath: resolve(args.source),
  sessionsRegistryPath: resolve(args["sessions-registry"]),
  remediationPreviewPath: resolve(args["remediation-preview"]),
  baselinePromotionPreviewPath: resolve(args["baseline-preview"]),
  planPath: resolve(args.plan),
  snapshotArchivePath: resolve(args["snapshot-archive"]),
  snapshotReceiptPath: resolve(args["snapshot-receipt"]),
  rolloutId: args["rollout-id"],
  planDigest: args["plan-digest"],
});
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
