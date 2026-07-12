#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLivePhase7GPreviewV1 } = jiti("../src/v2/operator/live-phase7g-preview.ts");

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
    "source", "snapshot-archive", "snapshot-receipt", "snapshot-restore-test",
    "receipt", "compatibility-rollout-id", "promotion-rollout-id",
  ]) if (!args[required]) throw new Error(`--${required} is required`);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receipt = await createLivePhase7GPreviewV1({
  sourcePath: resolve(args.source),
  snapshotArchivePath: resolve(args["snapshot-archive"]),
  snapshotReceiptPath: resolve(args["snapshot-receipt"]),
  snapshotRestoreTestPath: resolve(args["snapshot-restore-test"]),
  compatibilityRolloutId: args["compatibility-rollout-id"],
  promotionRolloutId: args["promotion-rollout-id"],
});
const receiptPath = resolve(args.receipt);
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
