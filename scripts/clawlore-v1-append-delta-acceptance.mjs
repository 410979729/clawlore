#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLiveV1AppendDeltaAcceptanceV1 } =
  jiti("../src/v2/operator/live-v1-append-delta-acceptance.ts");

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
  for (const required of ["source", "plan", "apply-receipt", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const receiptPath = resolve(args.receipt);
const acceptance = await createLiveV1AppendDeltaAcceptanceV1({
  sourcePath: resolve(args.source),
  planPath: resolve(args.plan),
  applyReceiptPath: resolve(args["apply-receipt"]),
});
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(acceptance, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify({ phase: acceptance.phase, rolloutId: acceptance.rolloutId,
  status: acceptance.status, source: acceptance.source, delta: acceptance.delta,
  lifecycle: acceptance.lifecycle, projections: acceptance.projections, database: acceptance.database })}\n`);
