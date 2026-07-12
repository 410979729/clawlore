#!/usr/bin/env node
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { executeLiveV1AppendDeltaV1 } = jiti("../src/v2/operator/live-v1-append-delta-apply.ts");

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
    "source", "baseline", "plan", "approval", "snapshot-archive", "snapshot-receipt",
    "rollout-id", "plan-digest", "tenant-id", "agent-id", "receipt",
  ]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const receipt = await executeLiveV1AppendDeltaV1({
  sourcePath: resolve(args.source),
  baselineReceiptPath: resolve(args.baseline),
  planPath: resolve(args.plan),
  approvalPath: resolve(args.approval),
  snapshotArchivePath: resolve(args["snapshot-archive"]),
  snapshotReceiptPath: resolve(args["snapshot-receipt"]),
  rolloutId: args["rollout-id"],
  planDigest: args["plan-digest"],
  defaults: {
    tenantId: args["tenant-id"],
    agentId: args["agent-id"],
    ...(args["workspace-id"] ? { workspaceId: args["workspace-id"] } : {}),
  },
});
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
