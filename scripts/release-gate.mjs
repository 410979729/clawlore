import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  compareRuntimeArtifactIdentity,
  runtimeArtifactIdentity,
} from "./release-artifact-identity.mjs";
import { scanReleaseDirectory } from "./release-content-scan.mjs";
import {
  ALLOWED_PLATFORM_VARIANCE,
  stableReleaseEvidenceMatches,
} from "./release-evidence-contract.mjs";
import { committedGitBlobSha256, releaseInputIdentity } from "./release-input-identity.mjs";
import { assertReleaseSourceState } from "./release-source-state.mjs";
import {
  assertRemoteReleaseCommit,
  assertRepositoryIdentity,
} from "./repository-identity.mjs";
import { assertReleaseDoctor } from "./release-operator-contract.mjs";

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function spawnTarget(command, args) {
  if (process.platform === "win32" && command === "npm") {
    const npmExecPath = String(process.env.npm_execpath || "").trim();
    if (!npmExecPath || !/npm-cli\.js$/i.test(npmExecPath)) {
      throw new Error("release gate failed: npm_execpath is required for shell-free Windows npm execution");
    }
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command, args };
}

function run(command, args, options = {}) {
  const target = spawnTarget(command, args);
  const result = spawnSync(target.command, target.args, {
    stdio: "inherit",
    shell: false,
    cwd: options.cwd,
    env: options.env || process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCapture(command, args, options = {}) {
  const target = spawnTarget(command, args);
  const result = spawnSync(target.command, target.args, {
    encoding: "utf8",
    shell: false,
    cwd: options.cwd,
    env: options.env || process.env,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout || "";
}

function runOpenClawCapture(command, args, options = {}) {
  if (/\.(?:c?js|mjs)$/i.test(command)) {
    return runCapture(process.execPath, [command, ...args], options);
  }
  return runCapture(command, args, options);
}

function captureOpenClawReport(command, args, options, label) {
  const target = /\.(?:c?js|mjs)$/i.test(command)
    ? { command: process.execPath, args: [command, ...args] }
    : spawnTarget(command, args);
  const result = spawnSync(target.command, target.args, {
    encoding: "utf8",
    shell: false,
    cwd: options.cwd,
    env: options.env || process.env,
  });
  if (result.error) throw result.error;
  return {
    report: parseJsonWithPreamble(result.stdout || "", label),
    status: result.status,
  };
}

function parseJsonWithPreamble(raw, label) {
  const start = raw.indexOf("{");
  if (start < 0) {
    throw new Error(`release gate failed: ${label} did not return JSON`);
  }
  try {
    return JSON.parse(raw.slice(start));
  } catch (err) {
    throw new Error(`release gate failed: ${label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function doctorArgs() {
  const args = ["clawlore", "doctor", "--json", "--quiet"];
  const principal = String(process.env.CLAWLORE_RUNTIME_PRINCIPAL || "").trim();
  if (principal) args.push("--principal", principal);
  return args;
}

function assertRuntimeDiagnostic(report, expectedRuntimeDigest) {
  const runtime = report?.runtimeDiagnostic;
  if (!runtime || runtime.ok !== true) {
    throw new Error("release gate failed: ClawLore runtime diagnostic did not report ok=true");
  }
  if (runtime.configuredMode === "disabled") {
    if (runtime.status !== "disabled") {
      throw new Error("release gate failed: disabled ClawLore runtime diagnostic is inconsistent");
    }
    return;
  }
  const receipt = runtime.receipt;
  if (
    runtime.status !== "registered"
    || receipt?.runtime?.status !== "registered"
    || receipt?.runtime?.registeredHookCount !== 1
    || JSON.stringify(receipt?.runtime?.registeredHooks) !== JSON.stringify(["message_received"])
    || receipt?.runtime?.writeEnabled !== false
    || receipt?.runtime?.promptMutationEnabled !== false
    || receipt?.runtime?.contextEngineRegistered !== false
    || !Array.isArray(receipt?.runtime?.blockingReasons)
    || receipt.runtime.blockingReasons.length !== 0
    || receipt?.readiness?.status !== "ready"
    || receipt?.readiness?.bindingVerified !== true
    || !Array.isArray(receipt?.readiness?.errors)
    || receipt.readiness.errors.length !== 0
    || (expectedRuntimeDigest && receipt?.binding?.runtimeDigest !== expectedRuntimeDigest)
  ) {
    throw new Error("release gate failed: ClawLore shadow runtime receipt contract is not satisfied");
  }
}

function isDeepSubset(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => isDeepSubset(value, actual[index]));
  }
  if (expected && typeof expected === "object") {
    return actual && typeof actual === "object" && !Array.isArray(actual) &&
      Object.entries(expected).every(([key, value]) => isDeepSubset(value, actual[key]));
  }
  return Object.is(expected, actual);
}

function changelogSection(changelog, version) {
  const marker = `## ${version}`;
  const start = changelog.indexOf(marker);
  if (start < 0) return "";
  const next = changelog.indexOf("\n## ", start + marker.length);
  return changelog.slice(start, next < 0 ? changelog.length : next);
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
const changelog = await readFile("CHANGELOG.md", "utf8");
const sourceRoot = await realpath(process.cwd());
const gitRoot = (await realpath(runCapture("git", ["rev-parse", "--show-toplevel"]).trim()));
const enabledByEnvironment = (...names) => names.some((name) => process.env[name] === "1");
const allowNestedGitRoot = enabledByEnvironment(
  "CLAWLORE_ALLOW_NESTED_GIT_ROOT",
  "SCOPE_RECALL_ALLOW_NESTED_GIT_ROOT",
);
const sourceOnly = enabledByEnvironment("CLAWLORE_SOURCE_ONLY", "SCOPE_RECALL_SOURCE_ONLY");
const prePush = enabledByEnvironment("CLAWLORE_PRE_PUSH");
const sourceInsideGitRoot = sourceRoot === gitRoot || sourceRoot.startsWith(`${gitRoot}/`);

if (prePush && !sourceOnly) {
  throw new Error("release gate failed: pre-push mode must remain source-only and non-authorizing");
}

if (gitRoot !== sourceRoot && !(allowNestedGitRoot && sourceInsideGitRoot)) {
  throw new Error(`release gate failed: run from plugin git root (${gitRoot}), not ${sourceRoot}`);
}

const repositoryIdentity = assertRepositoryIdentity({
  declaredRepository: packageJson.repository,
  originUrl: runCapture("git", ["remote", "get-url", "origin"]).trim(),
});
const gitCommit = runCapture("git", ["rev-parse", "HEAD"]).trim();
const releaseRef = String(process.env.CLAWLORE_RELEASE_REF || "refs/heads/main").trim();
if (prePush) {
  console.log("release gate: NON-AUTHORIZING pre-push mode; remote publication is deliberately not claimed");
} else {
  const remoteRefArgs = [releaseRef, ...(releaseRef.startsWith("refs/tags/") ? [`${releaseRef}^{}`] : [])];
  const remoteHeadProbe = spawnSync("git", ["ls-remote", "--exit-code", "origin", ...remoteRefArgs], {
    encoding: "utf8",
    shell: false,
    cwd: sourceRoot,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  assertRemoteReleaseCommit({
    identity: repositoryIdentity,
    status: remoteHeadProbe.status,
    stdout: remoteHeadProbe.stdout,
    localHead: gitCommit,
    targetRef: releaseRef,
  });
}

if (packageJson.version !== manifest.version) {
  throw new Error(
    `release gate failed: package.json version ${packageJson.version} does not match openclaw.plugin.json ${manifest.version}`,
  );
}

const releaseScriptContract = packageJson.clawloreRelease;
if (
  releaseScriptContract?.scriptPolicy !== "all-except-published-runtime-scripts-are-source-checkout-only" ||
  typeof releaseScriptContract?.evidenceFile !== "string" ||
  !releaseScriptContract.evidenceFile.startsWith("docs/clawlore/eval/") ||
  !Array.isArray(releaseScriptContract?.publishedRuntimeScripts) ||
  releaseScriptContract.publishedRuntimeScripts.length === 0
) {
  throw new Error("release gate failed: package script publication contract is missing or invalid");
}
if (
  packageJson.engines?.node !== ">=24.15.0 <25" ||
  JSON.stringify(packageJson.os) !== JSON.stringify(["linux", "win32"]) ||
  packageJson.peerDependencies?.openclaw !== ">=2026.7.1-beta.5 <2027" ||
  packageJson.peerDependenciesMeta?.openclaw?.optional !== true
) {
  throw new Error("release gate failed: Node/OpenClaw/OS compatibility contract is missing or invalid");
}
for (const scriptName of releaseScriptContract.publishedRuntimeScripts) {
  if (typeof packageJson.scripts?.[scriptName] !== "string") {
    throw new Error(`release gate failed: published runtime script is undefined: ${scriptName}`);
  }
}

const currentChangelog = changelogSection(changelog, packageJson.version);
if (!currentChangelog) {
  throw new Error(`release gate failed: CHANGELOG.md missing section for ${packageJson.version}`);
}

for (const marker of [
  "governance",
  "journal",
  "operator dashboard",
  "golden",
  "hard-delete",
  "release gate",
  "SQL authority",
  "OAuth session",
  "Windows ACL",
  "packed-tarball",
]) {
  if (!currentChangelog.includes(marker)) {
    throw new Error(`release gate failed: CHANGELOG ${packageJson.version} missing ${marker}`);
  }
}

const requiredFiles = [
  "README.md",
  "SECURITY.md",
  "docs/openclaw-contract-matrix.md",
  "docs/response-contracts.md",
  "docs/configuration.md",
  "docs/runtime-identity-scope-rules.md",
  "docs/phase-2-scope-identity-admission-audit-2026-06-30.md",
  "docs/phase-3-commercial-retrieval-audit-2026-06-30.md",
  "docs/phase-4-freshness-relation-audit-2026-06-30.md",
  "docs/phase-5-digest-audit-2026-06-30.md",
  "docs/phase-6-experience-productization-audit-2026-06-30.md",
  "docs/phase-7-release-hardening-audit-2026-06-30.md",
  "docs/operator-runbook.md",
  "docs/release-readiness-template.md",
  "docs/clawlore/identity-transition-v1.md",
  "docs/tianji-independent-roadmap-2026-07-01.md",
  "openclaw.plugin.json",
  "package-lock.json",
  "tsconfig.json",
  "index.ts",
  "src/product-identity.ts",
  "src/runtime-scope-metadata.ts",
  "src/embedder.ts",
  "src/experience-models.ts",
  "src/experience-store.ts",
  "src/experience-governance.ts",
  "src/experience-tools.ts",
  "src/experience-promotion.ts",
  "src/experience-replay.ts",
  "src/candidate-promotion.ts",
  "src/forgetting.ts",
  "src/graph-hygiene.ts",
  "src/governance-cleanup.ts",
  "src/journal-recovery.ts",
  "src/operator-dashboard.ts",
  "src/file-privacy.ts",
  "src/oauth-session-storage.ts",
  "src/sql-authority-migration.ts",
  "src/types/openclaw-plugin-sdk.d.ts",
  "benchmarks/golden-recall-cases.json",
  "benchmarks/experience-replay-cases.json",
  "scripts/golden-benchmark.mjs",
  "scripts/production-retrieval-benchmark.mjs",
  "scripts/packed-runtime-smoke.mjs",
  "scripts/packed-lancedb-smoke.mjs",
  "scripts/packed-legacy-identity-smoke.mjs",
  "scripts/smoke-vector-repair.mjs",
  releaseScriptContract.evidenceFile,
];

for (const file of requiredFiles) {
  if (!(await exists(file))) {
    throw new Error(`release gate failed: missing required file ${file}`);
  }
}

const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
if (packageLock.lockfileVersion < 3 || packageLock.packages?.[""]?.version !== packageJson.version) {
  throw new Error("release gate failed: package-lock.json is stale or not lockfileVersion 3+");
}
const lockRoot = packageLock.packages?.[""];
if (
  lockRoot?.engines?.node !== packageJson.engines.node ||
  JSON.stringify(lockRoot?.os) !== JSON.stringify(packageJson.os) ||
  lockRoot?.peerDependencies?.openclaw !== packageJson.peerDependencies.openclaw ||
  lockRoot?.peerDependenciesMeta?.openclaw?.optional !== true
) {
  throw new Error("release gate failed: package-lock compatibility metadata is stale");
}

const testFiles = (await exists("tests"))
  ? (await readdir("tests")).filter((name) => name.endsWith(".test.mjs"))
  : [];
if (testFiles.length === 0) {
  throw new Error("release gate failed: no tests/*.test.mjs files found");
}

for (const file of packageJson.files ?? []) {
  if (file.endsWith("/")) continue;
  if (!(await exists(file))) {
    throw new Error(`release gate failed: package.json files entry does not exist: ${file}`);
  }
}

const experienceStoreSource = await readFile("src/experience-store.ts", "utf8");
if (!experienceStoreSource.includes("buildSafeFtsQuery(") || !experienceStoreSource.includes("safeFtsQuery")) {
  throw new Error("release gate failed: Experience playbook FTS search must use buildSafeFtsQuery()");
}

const requiredExperienceTools = [
  "scope_recall_playbook_search",
  "scope_recall_playbook_inspect",
  "scope_recall_experience_preflight",
  "scope_recall_experience_stats",
  "scope_recall_experience_replay",
  "scope_recall_episode_create",
  "scope_recall_episode_complete",
  "scope_recall_playbook_create",
  "scope_recall_playbook_feedback",
  "scope_recall_experience_promote",
  "scope_recall_forgetting_report",
  "scope_recall_forgetting_run",
  "scope_recall_governance_cleanup_report",
  "scope_recall_governance_cleanup_run",
  "scope_recall_memory_candidate_promotion_report",
  "scope_recall_memory_candidate_promotion_run",
  "scope_recall_graph_hygiene_report",
  "scope_recall_graph_hygiene_run",
  "scope_recall_journal_recovery_report",
  "scope_recall_journal_recovery_run",
  "scope_recall_digest_report",
  "scope_recall_digest_run",
  "scope_recall_digest_recovery",
  "scope_recall_operator_dashboard",
  "scope_recall_playbook_review",
];
for (const toolName of requiredExperienceTools) {
  if (!manifest.contracts?.tools?.includes(toolName)) {
    throw new Error(`release gate failed: manifest missing Experience tool contract ${toolName}`);
  }
  if (typeof manifest.toolMetadata?.[toolName]?.discoverable !== "boolean") {
    throw new Error(`release gate failed: manifest missing boolean discoverability metadata for ${toolName}`);
  }
}

const alwaysAvailableExperienceTools = new Set([
  "scope_recall_playbook_search",
  "scope_recall_playbook_inspect",
  "scope_recall_experience_preflight",
]);
for (const toolName of requiredExperienceTools) {
  const discoverable = manifest.toolMetadata?.[toolName]?.discoverable;
  if (alwaysAvailableExperienceTools.has(toolName)) {
    if (discoverable !== true) {
      throw new Error(`release gate failed: core Experience tool ${toolName} must remain discoverable`);
    }
    continue;
  }
  if (discoverable !== false) {
    throw new Error(`release gate failed: operator Experience tool ${toolName} must not be discoverable by default`);
  }
  const signal = manifest.toolMetadata?.[toolName]?.configSignals?.[0];
  if (
    signal?.rootPath !== "plugins.entries.clawlore.config" ||
    signal?.mode?.path !== "enableManagementTools" ||
    !Array.isArray(signal?.mode?.allowed) ||
    !signal.mode.allowed.includes("true")
  ) {
    throw new Error(`release gate failed: management Experience tool ${toolName} missing enableManagementTools signal`);
  }
}

const indexSource = await readFile("index.ts", "utf8");
if (!indexSource.includes("registerExperienceTools(") || !indexSource.includes("ensureExperienceSchema(db)")) {
  throw new Error("release gate failed: index.ts does not initialize/register Experience Kernel");
}

// CLI capabilities are deliberately split; release policy must audit the whole
// published command surface instead of treating the compatibility facade as
// the implementation owner.
const CLI_SOURCE_PATHS = Object.freeze([
  "cli.ts",
  "src/cli/auth-commands.ts",
  "src/cli/auth-config-transaction.ts",
  "src/cli/cli-runtime-policy.ts",
  "src/cli/diagnostic-commands.ts",
  "src/cli/experience-commands.ts",
  "src/cli/governance-commands.ts",
  "src/cli/memory-commands.ts",
  "src/cli/migration-commands.ts",
]);
const cliSource = (await Promise.all(
  CLI_SOURCE_PATHS.map((path) => readFile(path, "utf8")),
)).join("\n");
for (const marker of ["collectExperienceHealth", "collectNightlyDigestHealth", "Experience Kernel"]) {
  if (!cliSource.includes(marker)) {
    throw new Error(`release gate failed: cli doctor missing ${marker}`);
  }
}
if (!cliSource.includes(".option(\"--apply\"") || !cliSource.includes("options.apply !== true")) {
  throw new Error("release gate failed: repair-vectors must be dry-run-first and require --apply for writes");
}
for (const marker of [
  ".command(\"dashboard\")",
  ".command(\"candidates\")",
  ".command(\"governance\")",
  ".command(\"journal\")",
  ".command(\"graph\")",
  ".command(\"forgetting\")",
  ".command(\"digest\")",
  ".command(\"experience\")",
  ".command(\"debt\")",
  ".command(\"replay\")",
  ".command(\"playbooks\")",
]) {
  if (!cliSource.includes(marker)) {
    throw new Error(`release gate failed: CLI missing Yuheng 1.6 operator route ${marker}`);
  }
}
for (const marker of [
  "buildOperatorDashboard",
  "promoteMemoryCandidates",
  "applyCleanup",
  "rollbackCleanupBatch",
  "scheduleReplay",
  "repairGraphHygiene",
  "runForgettingWithVectorSync",
  "buildExperienceDebtReport",
  "promoteExperiences",
  "runDigestPipeline",
  "digestRecoveryReport",
  "runReplaySuite",
  "loadReplayCases",
  "reviewPlaybook",
]) {
  if (!cliSource.includes(marker)) {
    throw new Error(`release gate failed: CLI missing operator implementation marker ${marker}`);
  }
}

for (const sqliteSourcePath of ["src/sql-truth-store.ts", "src/sqlite-vector-store.ts"]) {
  const sqliteSource = await readFile(sqliteSourcePath, "utf8");
  if (!sqliteSource.includes("PRAGMA busy_timeout = 10000")) {
    throw new Error(`release gate failed: ${sqliteSourcePath} must set SQLite busy_timeout`);
  }
}

const parityRoadmap = await readFile("docs/parity-roadmap.md", "utf8");
if (!parityRoadmap.includes("runtime-maturity-audit-2026-06-25.md")) {
  throw new Error("release gate failed: parity roadmap must link current runtime maturity audit");
}

const contractMatrix = await readFile("docs/openclaw-contract-matrix.md", "utf8");
for (const marker of ["Tool surface", "Scope isolation", "Recall Funnel trace", "Fact freshness", "Live rollout"]) {
  if (!contractMatrix.includes(marker)) {
    throw new Error(`release gate failed: contract matrix missing ${marker}`);
  }
}

const responseContracts = await readFile("docs/response-contracts.md", "utf8");
for (const marker of ["doctor", "dashboard", "freshness", "repair-vectors", "Governance Cleanup", "OpenClaw Digest", "Experience Replay", "Benchmark", "knownAnswerRecall", "forbiddenViolationRate", "promptBudget"]) {
  if (!responseContracts.includes(marker)) {
    throw new Error(`release gate failed: response contracts missing ${marker}`);
  }
}

const digestSource = await readFile("src/digest-pipeline.ts", "utf8");
for (const marker of ["ok_with_fallback", "dead_letter", "digest-candidate", "openclaw_digest_runs", "openclaw_digest_chunks"]) {
  if (!digestSource.includes(marker)) {
    throw new Error(`release gate failed: digest pipeline missing commercial marker ${marker}`);
  }
}

const retrieverSource = await readFile("src/retriever.ts", "utf8");
for (const marker of ["relation_evidence", "applyRelationEvidence", "conflict_review_penalty", "freshness_debt_penalty"]) {
  if (!retrieverSource.includes(marker)) {
    throw new Error(`release gate failed: retriever missing relation-aware marker ${marker}`);
  }
}
const dashboardSource = await readFile("src/operator-dashboard.ts", "utf8");
for (const marker of ["freshnessHealth", "freshness_debt", "unknown_freshness_facts"]) {
  if (!dashboardSource.includes(marker)) {
    throw new Error(`release gate failed: operator dashboard missing freshness marker ${marker}`);
  }
}

const goldenBenchmarkSource = await readFile("scripts/golden-benchmark.mjs", "utf8");
for (const marker of ["knownAnswerRecall", "topKAccuracy", "mrr", "ndcgAtK", "badRecallRate", "crossScopeLeakage", "promptBudget", "filterCounts"]) {
  if (!goldenBenchmarkSource.includes(marker)) {
    throw new Error(`release gate failed: golden benchmark missing metric ${marker}`);
  }
}
const productionBenchmarkSource = await readFile("scripts/production-retrieval-benchmark.mjs", "utf8");
for (const marker of ["MemoryStore", "MemoryRetriever", "retrieveWithTrace", "RecallAtK", "PrecisionAtK", "MRR", "nDCGAtK", "stageCoverage"]) {
  if (!productionBenchmarkSource.includes(marker)) {
    throw new Error(`release gate failed: production recall benchmark missing marker ${marker}`);
  }
}
const scalabilityBenchmarkSource = await readFile("scripts/scalability-benchmark.mjs", "utf8");
for (const marker of ["200_000", "knownAnswerRecall", "crossScopeLeakage", "p95"]) {
  if (!scalabilityBenchmarkSource.includes(marker)) {
    throw new Error(`release gate failed: scalability benchmark missing ${marker}`);
  }
}
const goldenCases = await readFile("benchmarks/golden-recall-cases.json", "utf8");
for (const marker of ["project-alpha-deploy", "project-beta-deploy", "home-ip-old", "home-ip-current", "max_prompt_chars"]) {
  if (!goldenCases.includes(marker)) {
    throw new Error(`release gate failed: golden benchmark fixture missing ${marker}`);
  }
}
const goldenFixture = JSON.parse(goldenCases);
if (!Array.isArray(goldenFixture.cases) || goldenFixture.cases.length < 100 || goldenFixture.cases.length > 300) {
  throw new Error("release gate failed: commercial recall benchmark must contain 100-300 annotated cases");
}
if (goldenFixture.cases.some((item) => item?.annotated !== true || !String(item?.annotation || "").trim())) {
  throw new Error("release gate failed: every commercial recall case must carry an explicit annotation");
}
for (const lane of ["fact-conflict", "preference-scope", "project-scope", "experience-forgetting", "multilingual-scope", "attack-scope"]) {
  if (!goldenFixture.cases.some((item) => item?.lane === lane)) {
    throw new Error(`release gate failed: commercial recall benchmark missing lane ${lane}`);
  }
}

const experienceReplayCases = JSON.parse(await readFile("benchmarks/experience-replay-cases.json", "utf8"));
if (!Array.isArray(experienceReplayCases) || experienceReplayCases.length < 6) {
  throw new Error("release gate failed: experience replay benchmark must contain at least six cases");
}
for (const marker of ["config-change-safety", "gateway-recovery", "vector-repair", "release-gate", "plugin-rollout", "telegram-delivery"]) {
  if (!experienceReplayCases.some((item) => item?.id === marker)) {
    throw new Error(`release gate failed: experience replay benchmark missing ${marker}`);
  }
}

const configurationReference = await readFile("docs/configuration.md", "utf8");
for (const marker of ["embedding.provider", "autoRecall", "autoCapture", "retrieval.mode", "taskExperienceCapture.enabled"]) {
  if (!configurationReference.includes(marker)) {
    throw new Error(`release gate failed: configuration reference missing ${marker}`);
  }
}

const runtimeIdentityRules = await readFile("docs/runtime-identity-scope-rules.md", "utf8");
for (const marker of ["openclaw-scope-v1", "scope_filter_mode", "memory_store", "foreign agent scopes", "Capture safety"]) {
  if (!runtimeIdentityRules.includes(marker)) {
    throw new Error(`release gate failed: runtime identity rules missing ${marker}`);
  }
}

const stateDir = resolve(process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || resolve(sourceRoot, "../../.."));
const extensionDir = resolve(
  process.env.CLAWLORE_EXTENSION_DIR ||
  process.env.SCOPE_RECALL_EXTENSION_DIR ||
  resolve(stateDir, "extensions/clawlore"),
);
if (!sourceOnly && !(await exists(extensionDir))) {
  throw new Error(`release gate failed: live extension target is missing: ${extensionDir}`);
}

const diffPathspec = gitRoot === sourceRoot ? "." : relative(gitRoot, sourceRoot);
const packageLockGitPath = relative(gitRoot, resolve(sourceRoot, "package-lock.json")).replaceAll("\\", "/");
run("git", ["diff", "--check", "--", diffPathspec || "."]);
const committedPackageLockSha256 = committedGitBlobSha256({ gitRoot, path: packageLockGitPath });
const workingPackageLockSha256 = createHash("sha256")
  .update(await readFile(resolve(sourceRoot, "package-lock.json")))
  .digest("hex");
if (workingPackageLockSha256 !== committedPackageLockSha256) {
  throw new Error("release gate failed: working-tree package-lock.json bytes differ from the committed Git blob");
}
run("node", ["scripts/dependency-preflight.mjs"]);
run("npm", ["test"]);
run("npm", ["run", "typecheck"]);
run("npm", ["run", "smoke:vector-repair"]);
run("npm", ["run", "build"]);
run("node", ["scripts/golden-benchmark.mjs", "--summary"]);
run("node", ["scripts/production-retrieval-benchmark.mjs", "--summary"]);
run("node", ["scripts/scalability-benchmark.mjs", "--rows", "200000", "--queries", "64"]);

const candidateIdentity = await runtimeArtifactIdentity(sourceRoot);
const gitDirty = Boolean(runCapture("git", ["status", "--porcelain", "--", diffPathspec || "."]).trim());
assertReleaseSourceState({ gitDirty, sourceOnly });
let extensionRoot;
if (sourceOnly) {
  console.log("release gate: explicit source-only mode; live extension and runtime smoke are not claimed");
} else {
  extensionRoot = await realpath(extensionDir);
  if (extensionRoot === sourceRoot) {
    throw new Error("release gate failed: extension dir resolves to source root; refusing self-drift comparison");
  }
  const deployedIdentity = await runtimeArtifactIdentity(extensionRoot);
  const comparison = compareRuntimeArtifactIdentity(candidateIdentity, deployedIdentity);
  if (!comparison.matches) {
    throw new Error(`release gate failed: recursive runtime artifact drift `
      + `(missing=${comparison.missing.length},extra=${comparison.extra.length},different=${comparison.different.length},`
      + `candidate=${comparison.candidateDigest},deployed=${comparison.deployedDigest})`);
  }
}
console.log(`release gate build identity: commit=${gitCommit} runtime=${candidateIdentity.digest} dirty=${gitDirty}`);

if (!sourceOnly && !enabledByEnvironment("CLAWLORE_SKIP_RUNTIME_SMOKE", "SCOPE_RECALL_SKIP_RUNTIME_SMOKE")) {
  const configPath = resolve(process.env.OPENCLAW_CONFIG_PATH || resolve(stateDir, "openclaw.json"));
  const inferredCli = resolve(stateDir, "../../app/node_modules/.bin/openclaw");
  const configuredCli = String(process.env.OPENCLAW_CLI || "").trim();
  const openclawCli = configuredCli && !["1", "true", "yes"].includes(configuredCli.toLowerCase())
    ? configuredCli
    : inferredCli;
  if (openclawCli.includes("/") && !(await exists(openclawCli))) {
    throw new Error(`release gate failed: OpenClaw CLI not found for runtime smoke: ${openclawCli}`);
  }
  if (!(await exists(configPath))) {
    throw new Error(`release gate failed: OpenClaw config not found for runtime smoke: ${configPath}`);
  }
  const runtimeEnv = {
    ...process.env,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  const inspect = parseJsonWithPreamble(
    runOpenClawCapture(openclawCli, ["plugins", "inspect", "clawlore", "--json"], { env: runtimeEnv }),
    "OpenClaw plugin inspect",
  );
  if (
    inspect.plugin?.id !== "clawlore" ||
    inspect.plugin?.status !== "loaded" ||
    inspect.plugin?.version !== packageJson.version ||
    inspect.plugin?.enabled !== true ||
    inspect.plugin?.activated !== true ||
    !Array.isArray(inspect.commands) ||
    !inspect.commands.includes("clawlore") ||
    !inspect.commands.includes("scope-recall") ||
    !inspect.commands.includes("memory-pro")
  ) {
    throw new Error("release gate failed: OpenClaw runtime did not load ClawLore with the canonical and compatibility command surface");
  }
  if (!inspect.plugin?.rootDir || await realpath(inspect.plugin.rootDir) !== extensionRoot) {
    throw new Error("release gate failed: OpenClaw inspect rootDir does not match the verified live extension");
  }
  const doctorResult = captureOpenClawReport(
    openclawCli,
    doctorArgs(),
    { env: runtimeEnv },
    "OpenClaw ClawLore doctor",
  );
  const doctor = assertReleaseDoctor({
    ...doctorResult,
    principal: String(process.env.CLAWLORE_RUNTIME_PRINCIPAL || "").trim(),
  });
  assertRuntimeDiagnostic(doctor, candidateIdentity.digest);
}

const packJson = runCapture("npm", ["pack", "--dry-run", "--json"]);
const packInfo = JSON.parse(packJson)[0];
const packFiles = (packInfo.files || []).map((file) => file.path);
for (const required of [
  "dist/index.js",
  "scripts/packed-runtime-smoke.mjs",
  "scripts/packed-lancedb-smoke.mjs",
  "scripts/packed-legacy-identity-smoke.mjs",
  "docs/operator-runbook.md",
  "docs/release-readiness-template.md",
  "benchmarks/experience-replay-cases.json",
  "openclaw.plugin.json",
]) {
  if (!packFiles.includes(required)) {
    throw new Error(`release gate failed: pack artifact missing ${required}`);
  }
}
for (const file of packFiles) {
  if (
    /(^|\/)node_modules\//.test(file) ||
    /(^|\/)(tmp|archive|backups?)\//i.test(file) ||
    /\.(sqlite|sqlite3|db|log|bak|tmp)$/i.test(file) ||
    /(^|\/)\.credentials($|\/)/i.test(file) ||
    /(^|\/)(credentials|secrets|tokens?)($|\/)/i.test(file) ||
    /(^|\/)\.env($|[.-])/i.test(file) ||
    /(api[_-]?key|password|credential[_-]?dump)/i.test(file)
  ) {
    throw new Error(`release gate failed: forbidden runtime/sensitive artifact in npm pack: ${file}`);
  }
}
const packScanRoot = await mkdtemp(resolve(tmpdir(), "clawlore-release-pack-"));
try {
  const packedJson = runCapture("npm", ["pack", "--json", "--pack-destination", packScanRoot]);
  const packedInfo = JSON.parse(packedJson)[0];
  const tarball = resolve(packScanRoot, String(packedInfo.filename));
  const extractRoot = resolve(packScanRoot, "extract");
  await mkdir(extractRoot, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", extractRoot]);
  const contentFindings = await scanReleaseDirectory(resolve(extractRoot, "package"));
  if (contentFindings.length > 0) {
    const summary = contentFindings
      .slice(0, 20)
      .map((finding) => `${finding.path}:${finding.line} (${finding.rule})`)
      .join(", ");
    throw new Error(`release gate failed: sensitive content found in npm pack: ${summary}`);
  }

  const installRoot = resolve(packScanRoot, "install");
  await mkdir(installRoot, { recursive: true });
  run("npm", [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    tarball,
  ], {
    cwd: installRoot,
    env: {
      ...process.env,
      npm_config_registry: "https://registry.npmjs.org",
    },
  });

  const installedRoot = resolve(installRoot, "node_modules", packageJson.name);
  const installedPackage = JSON.parse(await readFile(resolve(installedRoot, "package.json"), "utf8"));
  if (installedPackage.name !== packageJson.name || installedPackage.version !== packageJson.version) {
    throw new Error("release gate failed: installed tarball identity differs from candidate package");
  }
  if (
    installedPackage.clawloreRelease?.scriptPolicy !== releaseScriptContract.scriptPolicy ||
    JSON.stringify(installedPackage.clawloreRelease?.publishedRuntimeScripts) !==
      JSON.stringify(releaseScriptContract.publishedRuntimeScripts)
  ) {
    throw new Error("release gate failed: installed tarball lost the package script publication contract");
  }

  const configuredOpenClawPackage = String(process.env.OPENCLAW_PACKAGE_DIR || "").trim();
  const openClawPackage = resolve(
    configuredOpenClawPackage || resolve(stateDir, "../../app/node_modules/openclaw"),
  );
  if (!(await exists(openClawPackage))) {
    throw new Error(`release gate failed: OpenClaw package missing for packed runtime smoke: ${openClawPackage}`);
  }
  const installedOpenClaw = resolve(installRoot, "node_modules", "openclaw");
  await rm(installedOpenClaw, { recursive: true, force: true });
  await symlink(await realpath(openClawPackage), installedOpenClaw, "dir");
  run("node", [resolve(installedRoot, "scripts/packed-runtime-smoke.mjs")], {
    cwd: installedRoot,
  });
  run("node", [resolve(installedRoot, "scripts/packed-lancedb-smoke.mjs")], {
    cwd: installedRoot,
  });

  const configuredOpenClawCli = String(process.env.OPENCLAW_CLI || "").trim();
  const packedOpenClawCli = configuredOpenClawCli && !["1", "true", "yes"].includes(configuredOpenClawCli.toLowerCase())
    ? configuredOpenClawCli
    : resolve(openClawPackage, "../.bin/openclaw");
  if (!(await exists(packedOpenClawCli))) {
    throw new Error(`release gate failed: OpenClaw CLI missing for installed-tarball smoke: ${packedOpenClawCli}`);
  }
  const isolatedState = resolve(packScanRoot, "openclaw-state");
  await mkdir(isolatedState, { recursive: true });
  const isolatedConfig = resolve(isolatedState, "openclaw.json");
  const isolatedRuntimeEnv = {
    ...process.env,
    OPENCLAW_HOME: isolatedState,
    OPENCLAW_STATE_DIR: isolatedState,
    OPENCLAW_CONFIG_PATH: isolatedConfig,
    npm_config_registry: "https://registry.npmjs.org",
  };
  runOpenClawCapture(packedOpenClawCli, ["config", "set", "gateway.mode", "local"], { env: isolatedRuntimeEnv });
  runOpenClawCapture(packedOpenClawCli, ["config", "set", "gateway.port", "29999", "--strict-json"], { env: isolatedRuntimeEnv });
  const isolatedPluginEntry = JSON.stringify({
    enabled: true,
    config: {
      embedding: { provider: "local-hash", dimensions: 64 },
      vectorBackend: "sqlite-bruteforce",
      dbPath: resolve(isolatedState, "memory/clawlore"),
      enableManagementTools: true,
    },
  });
  runOpenClawCapture(
    packedOpenClawCli,
    ["config", "set", "plugins.entries.clawlore", isolatedPluginEntry, "--strict-json"],
    { env: isolatedRuntimeEnv },
  );
  runOpenClawCapture(packedOpenClawCli, ["plugins", "install", tarball], { env: isolatedRuntimeEnv });
  runOpenClawCapture(packedOpenClawCli, ["config", "set", "plugins.slots.memory", "clawlore"], { env: isolatedRuntimeEnv });
  const packedInspect = parseJsonWithPreamble(
    runOpenClawCapture(packedOpenClawCli, ["plugins", "inspect", "clawlore", "--json"], { env: isolatedRuntimeEnv }),
    "installed-tarball OpenClaw inspect",
  );
  if (
    packedInspect.plugin?.id !== "clawlore" ||
    packedInspect.plugin?.status !== "loaded" ||
    packedInspect.plugin?.version !== packageJson.version ||
    packedInspect.plugin?.enabled !== true ||
    packedInspect.plugin?.activated !== true ||
    !["clawlore", "scope-recall", "memory-pro"].every((command) => packedInspect.commands?.includes(command))
  ) {
    throw new Error("release gate failed: installed tarball did not load through the real OpenClaw CLI");
  }
  runOpenClawCapture(packedOpenClawCli, ["clawlore", "experience", "debt", "--json"], { env: isolatedRuntimeEnv });
  const packedDoctor = parseJsonWithPreamble(
    runOpenClawCapture(packedOpenClawCli, ["clawlore", "doctor", "--json", "--quiet"], { env: isolatedRuntimeEnv }),
    "installed-tarball OpenClaw doctor",
  );
  if (packedDoctor.ok !== true) {
    throw new Error("release gate failed: installed-tarball OpenClaw doctor did not report ok=true");
  }
  assertRuntimeDiagnostic(packedDoctor);
  for (const command of ["clawlore", "scope-recall", "memory-pro"]) {
    const versionOutput = runOpenClawCapture(packedOpenClawCli, [command, "version"], { env: isolatedRuntimeEnv });
    if (!versionOutput.includes(packageJson.version)) {
      throw new Error(`release gate failed: installed-tarball ${command} version smoke failed`);
    }
  }

  const legacyState = resolve(packScanRoot, "openclaw-legacy-state");
  await mkdir(legacyState, { recursive: true });
  const legacyConfigPath = resolve(legacyState, "openclaw.json");
  const legacyDbPath = resolve(legacyState, "memory/clawlore");
  const legacyRuntimeEnv = {
    ...process.env,
    OPENCLAW_HOME: legacyState,
    OPENCLAW_STATE_DIR: legacyState,
    OPENCLAW_CONFIG_PATH: legacyConfigPath,
    CLAWLORE_RELEASE_FIXTURE_CREDENTIAL: "fixture-not-a-secret",
    npm_config_registry: "https://registry.npmjs.org",
  };
  runOpenClawCapture(packedOpenClawCli, ["config", "set", "gateway.mode", "local"], { env: legacyRuntimeEnv });
  runOpenClawCapture(packedOpenClawCli, ["config", "set", "gateway.port", "29998", "--strict-json"], { env: legacyRuntimeEnv });
  runOpenClawCapture(
    packedOpenClawCli,
    ["config", "set", "plugins.entries.clawlore", isolatedPluginEntry, "--strict-json"],
    { env: legacyRuntimeEnv },
  );
  runOpenClawCapture(packedOpenClawCli, ["plugins", "install", tarball], { env: legacyRuntimeEnv });
  run("node", [
    resolve(installedRoot, "scripts/packed-legacy-identity-smoke.mjs"),
    legacyConfigPath,
    legacyDbPath,
  ], { cwd: installedRoot, env: legacyRuntimeEnv });

  const legacyValidation = parseJsonWithPreamble(
    runOpenClawCapture(packedOpenClawCli, ["config", "validate", "--json"], { env: legacyRuntimeEnv }),
    "legacy-migrated OpenClaw config validation",
  );
  if (legacyValidation.valid !== true) {
    throw new Error("release gate failed: legacy-migrated config did not validate in real OpenClaw");
  }
  const effectiveLegacyConfig = parseJsonWithPreamble(
    runOpenClawCapture(
      packedOpenClawCli,
      ["config", "get", "plugins.entries.clawlore.config", "--json"],
      { env: legacyRuntimeEnv },
    ),
    "legacy-migrated effective ClawLore config",
  );
  const migratedSourceConfig = JSON.parse(await readFile(legacyConfigPath, "utf8"));
  const expectedLegacyConfig = migratedSourceConfig.plugins?.entries?.clawlore?.config;
  const rawLegacyApiKey = expectedLegacyConfig?.llm?.apiKey;
  const expectedEffectiveLegacyConfig = expectedLegacyConfig
    ? structuredClone(expectedLegacyConfig)
    : undefined;
  if (expectedEffectiveLegacyConfig?.llm?.apiKey) {
    expectedEffectiveLegacyConfig.llm.apiKey = {
      source: "__OPENCLAW_REDACTED__",
      provider: "__OPENCLAW_REDACTED__",
      id: "__OPENCLAW_REDACTED__",
    };
  }
  if (
    !expectedLegacyConfig ||
    Object.keys(expectedLegacyConfig).length !== 30 ||
    expectedLegacyConfig.dbPath !== legacyDbPath ||
    rawLegacyApiKey?.source !== "env" ||
    rawLegacyApiKey?.provider !== "default" ||
    rawLegacyApiKey?.id !== "CLAWLORE_RELEASE_FIXTURE_CREDENTIAL" ||
    !isDeepSubset(expectedEffectiveLegacyConfig, effectiveLegacyConfig) ||
    effectiveLegacyConfig.dbPath !== legacyDbPath ||
    effectiveLegacyConfig.llm?.apiKey?.source !== "__OPENCLAW_REDACTED__" ||
    effectiveLegacyConfig.llm?.apiKey?.provider !== "__OPENCLAW_REDACTED__" ||
    effectiveLegacyConfig.llm?.apiKey?.id !== "__OPENCLAW_REDACTED__"
  ) {
    throw new Error("release gate failed: real OpenClaw changed or truncated the migrated 30-key config");
  }
  const legacyInspect = parseJsonWithPreamble(
    runOpenClawCapture(packedOpenClawCli, ["plugins", "inspect", "clawlore", "--json"], { env: legacyRuntimeEnv }),
    "legacy-migrated installed-tarball OpenClaw inspect",
  );
  if (
    legacyInspect.plugin?.id !== "clawlore" ||
    legacyInspect.plugin?.status !== "loaded" ||
    legacyInspect.plugin?.enabled !== true ||
    legacyInspect.plugin?.activated !== true
  ) {
    throw new Error("release gate failed: migrated legacy identity did not activate canonical ClawLore");
  }
  runOpenClawCapture(packedOpenClawCli, ["clawlore", "experience", "debt", "--json"], { env: legacyRuntimeEnv });
  const legacyDoctor = parseJsonWithPreamble(
    runOpenClawCapture(packedOpenClawCli, ["clawlore", "doctor", "--json", "--quiet"], { env: legacyRuntimeEnv }),
    "legacy-migrated installed-tarball OpenClaw doctor",
  );
  if (legacyDoctor.ok !== true) {
    throw new Error("release gate failed: migrated legacy identity doctor did not report ok=true");
  }
  assertRuntimeDiagnostic(legacyDoctor);
} finally {
  await rm(packScanRoot, { recursive: true, force: true });
}
const sbomRaw = runCapture("npm", ["sbom", "--package-lock-only", "--sbom-format", "cyclonedx"]);
const sbom = JSON.parse(sbomRaw);
if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components) || sbom.components.length === 0) {
  throw new Error("release gate failed: package-lock SBOM is empty or invalid");
}
const sbomDigest = createHash("sha256").update(sbomRaw).digest("hex");
console.log(`release gate SBOM ok: ${sbom.components.length} components sha256=${sbomDigest}`);
run("node", ["scripts/supply-chain-audit.mjs"]);
console.log(`release gate pack filename/content scan ok: ${packFiles.length} files`);
const releaseEvidence = {
  schema: "clawlore.release-evidence.v3",
  package: `${packageJson.name}@${packageJson.version}`,
  observedCommit: gitCommit,
  releaseInput: releaseInputIdentity({ gitRoot, sourceRoot, diffPathspec }),
  runtimeDigest: candidateIdentity.digest,
  sourceOnly,
  publicationVerified: !prePush,
  dirty: gitDirty,
  packFileCount: packFiles.length,
  packageLockSha256: committedPackageLockSha256,
  sbom: {
    format: sbom.bomFormat,
    specVersion: sbom.specVersion,
    tool: "npm sbom --package-lock-only --sbom-format cyclonedx",
    toolVersion: runCapture("npm", ["--version"]).trim(),
    componentCount: sbom.components.length,
    sha256: sbomDigest,
  },
  toolchain: {
    node: process.version,
    npm: runCapture("npm", ["--version"]).trim(),
    os: process.platform,
    arch: process.arch,
  },
  compatibility: {
    node: packageJson.engines.node,
    os: packageJson.os,
    openclawPeer: packageJson.peerDependencies.openclaw,
  },
  supplyChainRegistry: "https://registry.npmjs.org",
  packedRuntimeSmoke: true,
  packedLanceDbSmoke: true,
  packedOpenClawCliSmoke: true,
  allowedPlatformVariance: ALLOWED_PLATFORM_VARIANCE,
};
const evidenceJson = `${JSON.stringify(releaseEvidence, null, 2)}\n`;
const canonicalEvidencePath = resolve(releaseScriptContract.evidenceFile);
const writeCanonicalEvidence = enabledByEnvironment("CLAWLORE_WRITE_RELEASE_EVIDENCE");
if (prePush && writeCanonicalEvidence) {
  throw new Error("release gate failed: non-authorizing pre-push mode cannot write canonical release evidence");
} else if (prePush) {
  console.log("release gate: pre-push evidence is ephemeral; canonical release evidence was not accepted or rewritten");
} else if (writeCanonicalEvidence) {
  await writeFile(canonicalEvidencePath, evidenceJson, { encoding: "utf8", mode: 0o600 });
} else {
  const checkedEvidence = JSON.parse(await readFile(canonicalEvidencePath, "utf8"));
  if (!stableReleaseEvidenceMatches(checkedEvidence, releaseEvidence)) {
    throw new Error("release gate failed: checked-in release evidence does not match current release inputs");
  }
}
const evidencePath = String(process.env.CLAWLORE_RELEASE_EVIDENCE_PATH || "").trim();
if (evidencePath) {
  await writeFile(resolve(evidencePath), evidenceJson, { encoding: "utf8", mode: 0o600 });
}
console.log(`release gate evidence: ${JSON.stringify(releaseEvidence)}`);
