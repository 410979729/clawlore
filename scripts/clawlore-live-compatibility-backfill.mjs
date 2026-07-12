#!/usr/bin/env node
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { executeLiveCompatibilityBackfillV1 } =
  jiti("../src/v2/operator/live-compatibility-backfill.ts");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(`invalid argument near ${name || "<end>"}`);
    args[name.slice(2)] = value;
  }
  for (const required of ["source", "preview", "approval", "rollout-id", "plan-digest", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receipt = await executeLiveCompatibilityBackfillV1({
  sourcePath: resolve(args.source),
  previewPath: resolve(args.preview),
  approvalPath: resolve(args.approval),
  rolloutId: args["rollout-id"],
  planDigest: args["plan-digest"],
});
const receiptPath = resolve(args.receipt);
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
