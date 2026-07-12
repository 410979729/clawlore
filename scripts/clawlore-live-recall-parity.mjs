#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { inspectLiveV1V2RecallParityV1 } = jiti("../src/v2/eval/live-v1-v2-recall-parity.ts");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(`invalid argument near ${name || "<end>"}`);
    args[name.slice(2)] = value;
  }
  for (const required of ["source", "queries", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const queryDocument = JSON.parse(await readFile(resolve(args.queries), "utf8"));
if (!Array.isArray(queryDocument.queries)) throw new Error("query document must contain a queries array");
const report = inspectLiveV1V2RecallParityV1({
  sqlitePath: resolve(args.source),
  queries: queryDocument.queries,
});
const receiptPath = resolve(args.receipt);
await writeFile(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(receiptPath, 0o600);
process.stdout.write(`${JSON.stringify(report)}\n`);
