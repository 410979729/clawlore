#!/usr/bin/env node
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { MemoryStore } = jiti("../src/store.ts");
const { VectorScopeMetadataUpdater } = jiti("../src/vector-scope-metadata-updater.ts");
const { finalizeLivePrincipalScopeVectorsV1 } =
  jiti("../src/v2/operator/live-principal-scope-vector-finalize.ts");

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
  for (const required of ["db-dir", "vector-dim", "migration-id", "plan-digest", "receipt"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const vectorDim = Number(args["vector-dim"]);
if (!Number.isInteger(vectorDim) || vectorDim <= 0) throw new Error("--vector-dim must be a positive integer");
const vectorBackend = args["vector-backend"] ?? "lancedb";
if (!["lancedb", "sqlite-bruteforce"].includes(vectorBackend)) {
  throw new Error("--vector-backend must be lancedb or sqlite-bruteforce");
}
const store = new MemoryStore({ dbPath: resolve(args["db-dir"]), vectorDim, vectorBackend });
const scopeUpdater = new VectorScopeMetadataUpdater({
  dbPath: resolve(args["db-dir"]), vectorDim, vectorBackend,
});
try {
  const receipt = await finalizeLivePrincipalScopeVectorsV1({
    store,
    scopeUpdater,
    migrationId: args["migration-id"],
    expectedPlanDigest: args["plan-digest"],
  });
  const receiptPath = resolve(args.receipt);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(receiptPath, 0o600);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  try { await scopeUpdater.close(); } finally { await store.close(); }
}
