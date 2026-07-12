#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { executeLiveV2WriteRolloutV1 } = jiti("../src/v2/operator/live-v2-write-rollout.ts");

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
    "source", "readiness", "approval", "receipt", "rollout-id", "tenant", "agent", "v1-vector-rows",
  ]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const vectorRows = Number(args["v1-vector-rows"]);
  if (!Number.isSafeInteger(vectorRows) || vectorRows < 0) throw new Error("--v1-vector-rows must be a non-negative integer");
  return { ...args, vectorRows };
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const receipt = await executeLiveV2WriteRolloutV1({
  sourcePath: resolve(args.source),
  readinessPath: resolve(args.readiness),
  approvalPath: resolve(args.approval),
  rolloutId: args["rollout-id"],
  defaults: {
    tenantId: args.tenant,
    agentId: args.agent,
    ...(args.workspace ? { workspaceId: args.workspace } : {}),
  },
  expectedV1VectorRows: args.vectorRows,
});
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
