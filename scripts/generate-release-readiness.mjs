import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createJiti } from "jiti";
import { assertFinalReadinessPointer } from "./release-readiness-path.mjs";
import {
  releaseEvidenceFromEnvironment,
  resolveReleaseReadinessMode,
  shadowEvidenceFromPriorReadiness,
} from "./release-readiness-input.mjs";

const root = process.cwd();
const jiti = createJiti(import.meta.url);
const { parsePluginConfig } = jiti(resolve(root, "index.ts"));
const {
  BUILD_PROVENANCE_FILE,
  computeRuntimeReleaseBinding,
} = jiti(resolve(root, "src/release-provenance.ts"));
const { buildReleaseReadinessReceipt } = jiti(resolve(root, "src/v2/application/release-readiness.ts"));
const {
  CLAWLORE_LEGACY_PLUGIN_IDS,
  CLAWLORE_PLUGIN_ID,
} = jiti(resolve(root, "src/product-identity.ts"));

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pluginConfig(rootConfig) {
  const entries = rootConfig?.plugins?.entries ?? {};
  const value = entries[CLAWLORE_PLUGIN_ID]?.config ?? entries[CLAWLORE_LEGACY_PLUGIN_IDS[0]]?.config;
  if (!value) throw new Error("ClawLore plugin config is missing from OpenClaw config");
  return parsePluginConfig(value);
}

function shadowEvidence(tracePath) {
  const empty = {
    sampleCount: 0,
    directSamples: 0,
    groupSamples: 0,
    positiveCandidateSamples: 0,
    overlapRatio: 0,
    rankAgreement: 0,
    p95LatencyMs: 0,
    forbiddenViolations: 0,
    promptBudgetViolations: 0,
  };
  if (!tracePath) return empty;
  const rows = readFileSync(resolve(tracePath), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (rows.length === 0) return empty;
  const latencies = rows.map((row) => Number(row.latencyMs ?? row.totalLatencyMs ?? 0)).filter(Number.isFinite).sort((a, b) => a - b);
  const comparisons = rows.filter((row) => row.comparison && typeof row.comparison === "object");
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    sampleCount: rows.length,
    directSamples: rows.filter((row) => row.ingressKind === "direct").length,
    groupSamples: rows.filter((row) => row.ingressKind === "group" || row.ingressKind === "channel").length,
    positiveCandidateSamples: rows.filter((row) => Number(row.candidateCount ?? row.primaryCandidateCount ?? 0) > 0).length,
    overlapRatio: mean(comparisons.map((row) => Number(row.comparison.overlapRatio ?? 0))),
    rankAgreement: mean(comparisons.map((row) => Number(row.comparison.rankAgreement ?? 0))),
    p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0,
    forbiddenViolations: rows.filter((row) => Number(row.forbiddenViolations ?? 0) > 0).length,
    promptBudgetViolations: rows.filter((row) => row.promptBudgetExceeded === true).length,
  };
}

const testLog = required("CLAWLORE_TEST_LOG");
const configPath = required("CLAWLORE_CONFIG");
const sqlitePath = required("CLAWLORE_SQLITE");
const readinessOut = required("CLAWLORE_READINESS_OUT");
const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
const config = pluginConfig(rawConfig);
assertFinalReadinessPointer({
  configuredReadinessFile: config.runtime?.readinessFile,
  readinessOut,
});
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`release provenance requires a clean source tree:\n${dirty}`);

const createdAt = new Date();
const expiresHours = Math.max(1, Math.min(72, Number(process.env.CLAWLORE_EXPIRES_HOURS || 24)));
const generatedBy = process.env.CLAWLORE_GENERATED_BY?.trim() || "clawlore-release-readiness";
const buildProvenance = {
  schemaVersion: 1,
  sourceCommit,
  testLogDigest: sha256File(testLog),
  generatedBy,
  createdAt: createdAt.toISOString(),
};
mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist", BUILD_PROVENANCE_FILE), `${JSON.stringify(buildProvenance, null, 2)}\n`, { mode: 0o644 });

const binding = computeRuntimeReleaseBinding({ pluginRoot: root, config, sqlitePath });
const rolloutMode = resolveReleaseReadinessMode(config.runtime?.mode);
const evidence = releaseEvidenceFromEnvironment(rolloutMode);
const tracePath = process.env.CLAWLORE_TRACE?.trim();
const priorReadinessPath = process.env.CLAWLORE_PRIOR_READINESS?.trim();
if (tracePath && priorReadinessPath) {
  throw new Error("CLAWLORE_TRACE and CLAWLORE_PRIOR_READINESS are mutually exclusive");
}
const observedShadow = tracePath
  ? shadowEvidence(tracePath)
  : priorReadinessPath
    ? shadowEvidenceFromPriorReadiness(
        JSON.parse(readFileSync(resolve(priorReadinessPath), "utf8")),
        { mode: rolloutMode, binding, now: createdAt },
      )
    : shadowEvidence();
const receipt = buildReleaseReadinessReceipt({
  rolloutId: `clawlore-${sourceCommit.slice(0, 12)}-${createdAt.toISOString()}`,
  requestedMode: rolloutMode,
  currentMode: rolloutMode,
  evidence,
  compatibilityFailures: [],
  provenance: {
    sourceCommit: binding.sourceCommit,
    runtimeDigest: binding.runtimeDigest,
    packageDigest: binding.packageDigest,
    lockDigest: binding.lockDigest,
    configDigest: binding.configDigest,
    truthSnapshotDigest: binding.truthSnapshotDigest,
    testLogDigest: binding.testLogDigest,
    generatedBy,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + expiresHours * 60 * 60 * 1000).toISOString(),
    lifecycle: binding.lifecycle,
    shadow: observedShadow,
  },
  now: () => createdAt,
});
mkdirSync(dirname(readinessOut), { recursive: true });
writeFileSync(readinessOut, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
chmodSync(readinessOut, 0o600);
process.stdout.write(`${JSON.stringify({
  sourceCommit,
  runtimeDigest: binding.runtimeDigest,
  readinessOut,
  status: receipt.status,
  blockingReasons: receipt.rollout.blockingReasons,
}, null, 2)}\n`);
