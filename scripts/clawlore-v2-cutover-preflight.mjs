import { resolve } from "node:path";
import { inspectRuntimeV2CutoverPreflightV1 } from "../dist/src/v2/operator/runtime-cutover-preflight.js";

const sqlitePath = process.argv[2] ? resolve(process.argv[2]) : "";
if (!sqlitePath) {
  process.stderr.write("Usage: npm run preflight:clawlore-v2-cutover -- /absolute/path/memory.sqlite3\n");
  process.exitCode = 2;
} else {
  const receipt = inspectRuntimeV2CutoverPreflightV1(sqlitePath);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.cutoverReady) process.exitCode = 1;
}
