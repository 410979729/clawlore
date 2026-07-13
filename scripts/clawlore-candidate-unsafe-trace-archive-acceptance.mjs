#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { acceptLiveCandidateUnsafeTraceArchiveV1 } =
  jiti("../src/v2/operator/live-candidate-unsafe-trace-archive.ts");

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
  for (const required of ["source", "plan", "plan-digest", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const receipt = acceptLiveCandidateUnsafeTraceArchiveV1({
  sourcePath: resolve(args.source),
  planPath: resolve(args.plan),
  planDigest: args["plan-digest"],
});
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({
  phase: receipt.phase,
  status: receipt.status,
  planDigest: receipt.planDigest,
  summary: receipt.summary,
  protectedRewriteRowsDigest: receipt.protectedRewriteRowsDigest,
  requiresFreshEncryptedSnapshot: receipt.requiresFreshEncryptedSnapshot,
})}\n`);
