import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { compareLegacyContextToContextPack } = jiti("../src/v2/eval/legacy-context-shadow-comparison.ts");
const fixture = JSON.parse(readFileSync(
  new URL("../tests/fixtures/clawlore-legacy-context-shadow-v1.json", import.meta.url),
  "utf8",
));

const first = compareLegacyContextToContextPack(fixture);
const second = compareLegacyContextToContextPack(fixture);
const deterministic = JSON.stringify(first) === JSON.stringify(second);
const pass = first.mode === "shadow"
  && first.legacy.hookOutputCount === 3
  && first.unified.contextPackCount === 1
  && first.parity.candidateCount === 5
  && first.unified.selectedCount === 5
  && first.parity.rejected.length === 0
  && first.hookResult === undefined
  && deterministic;

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  status: pass ? "PASS" : "FAIL",
  mode: first.mode,
  legacyHookOutputs: first.legacy.hookOutputCount,
  legacyBlockTags: first.legacy.blockTags,
  unifiedContextPacks: first.unified.contextPackCount,
  candidates: first.parity.candidateCount,
  selected: first.unified.selectedCount,
  rejected: first.parity.rejected.length,
  deterministic,
  hookMutationProduced: first.hookResult !== undefined,
}, null, 2)}\n`);

if (!pass) process.exitCode = 1;
