#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { replayHistoricalTaskExperienceCaptureV1 } = jiti(
  "../src/v2/operator/task-experience-shadow-replay.ts",
);

function parseArgs(argv) {
  const args = { "transcript-dir": [] };
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument: ${token ?? ""}`);
    const key = token.slice(2);
    if (key === "transcript-dir") args[key].push(value);
    else args[key] = value;
  }
  for (const required of ["source", "output"]) if (!args[required]) throw new Error(`--${required} is required`);
  if (!args["transcript-dir"].length) throw new Error("at least one --transcript-dir is required");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const report = replayHistoricalTaskExperienceCaptureV1({
  sourcePath: resolve(args.source),
  transcriptDirectories: args["transcript-dir"].map((path) => resolve(path)),
});
await writeFile(resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: report.status, correlation: report.correlation, candidateGate: report.candidateGate, safety: report.safety })}\n`);
if (report.status !== "pass") process.exitCode = 2;
