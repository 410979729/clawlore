import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const srcRoot = resolve("src");

async function filesUnder(path, suffix) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(child, suffix));
    else if (entry.isFile() && child.endsWith(suffix)) result.push(child);
  }
  return result;
}

function importedSpecifiers(source) {
  const result = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^"'\n]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) result.push(match[1]);
  return result;
}

// This inventory describes the predominant responsibility of migration-era
// root modules. It is a debt map, not a claim that every module is already pure.
const ROOT_MODULES_BY_LAYER = {
  composition: [
    "adapters/openclaw/runtime-composition-root.ts",
    "auto-capture-hooks.ts", "auto-recall-hooks.ts", "core-memory-runtime.ts", "plugin-config.ts",
    "reflection-hooks.ts", "reflection-runtime-state.ts", "self-improvement-hooks.ts",
    "task-experience-hooks.ts",
    "runtime-shadow-registration.ts",
  ],
  domain: [
    "auto-capture-policy.ts", "auto-recall-query.ts", "auto-recall-session-boundary.ts", "bounded-ttl-map.ts", "capture-safety.ts",
    "decay-engine.ts", "experience-models.ts", "experience-persistence-policy.ts", "experience-playbook-successor-policy.ts", "experience-schemas.ts",
    "extraction-prompts.ts", "lifecycle-metadata.ts", "memory-categories.ts", "memory-egress-policy.ts", "memory-entry-write-policy.ts", "memory-merge-policy.ts", "memory-metadata-policy.ts", "noise-filter.ts",
    "noise-prototypes.ts", "preference-slots.ts", "product-identity.ts", "self-improvement-content-policy.ts",
    "reflection-contracts.ts", "reflection-mapped-metadata.ts", "reflection-metadata.ts", "reflection-ranking.ts",
    "principal-write-boundary.ts", "reflection-slices.ts", "runtime-accessibility-diagnostic.ts", "runtime-memory-boundary.ts", "runtime-scope-metadata.ts",
    "diagnostic-redaction.ts", "llm-failure-diagnostic.ts", "provider-output-policy.ts", "scope-policy.ts", "secret-redaction.ts", "secret-structured-text.ts", "smart-metadata.ts",
    "task-experience-capsule.ts", "task-experience-review.ts", "task-outcome-evidence.ts",
  ],
  application: [
    "application/context-composer.ts", "application/identity-resolver.ts",
    "application/legacy-address-mapper.ts", "application/policy-decision.ts",
    "application/support-bundle.ts",
    "access-tracker.ts", "adaptive-retrieval.ts", "admission-control.ts",
    "admission-stats.ts", "auto-capture-cleanup.ts", "auto-capture-governance.ts",
    "auto-capture-session-state.ts",
    "auto-recall-ledger.ts", "batch-dedup.ts", "candidate-promotion.ts",
    "chunker.ts", "conflict-governance.ts", "digest-pipeline.ts", "embedding-noise-filter.ts",
    "digest-boundary-policy.ts", "experience-governance.ts", "experience-promotion-batch.ts", "experience-promotion.ts",
    "experience-replay.ts", "forgetting.ts", "governance-cleanup.ts",
    "graph-hygiene.ts", "identity-addressing.ts", "intent-analyzer.ts",
    "knowledge-skill-bridge.ts", "memory-upgrader.ts",
    "memory-store-facade.ts", "memory-store-ports.ts",
    "reflection-retry.ts", "retrieval-stats.ts", "retrieval-trace.ts",
    "retriever.ts", "session-compressor.ts", "smart-extractor.ts",
    "sql-lifecycle-projection.ts", "sqlite-savepoint.ts", "task-experience.ts", "tier-manager.ts",
  ],
  adapters: [
    "adapters/openclaw/compatibility-context-adapter.ts", "adapters/openclaw/context-engine-skeleton.ts",
    "adapters/openclaw/legacy-shadow-retrieval.ts", "adapters/openclaw/native-shadow-retrieval.ts",
    "adapters/openclaw/legacy-context-sources.ts",
    "experience-episode-tools.ts", "experience-operator-tools.ts", "experience-playbook-tools.ts",
    "experience-query-tools.ts", "experience-review-tools.ts", "experience-tool-runtime-policy.ts",
    "experience-tools.ts", "memory-diagnostic-tools.ts", "memory-governance-tools.ts",
    "memory-lifecycle-tools.ts", "memory-recall-tools.ts", "memory-write-tools.ts",
    "reflection-command-orchestrator.ts", "reflection-generation.ts",
    "reflection-transcript.ts", "runtime-config.ts", "scopes.ts", "self-improvement-tools.ts",
    "session-recovery.ts", "tool-runtime-policy.ts", "tools.ts",
    "types/openclaw-plugin-sdk.d.ts",
  ],
  infrastructure: [
    "artifacts.ts", "embedder.ts", "experience-store.ts", "file-privacy.ts",
    "journal-recovery.ts", "lancedb-loader.ts", "llm-client.ts", "llm-oauth.ts", "memory-write-lock.ts",
    "oauth-session-storage.ts", "private-lock-file.ts", "proper-lockfile.d.ts",
    "reflection-event-store.ts", "reflection-item-store.ts",
    "reflection-store.ts", "secret-index.ts",
    "sql-authority-migration.ts", "sql-truth-store.ts", "sqlite-vector-store.ts",
    "storage-path.ts", "store.ts", "vector-scope-metadata-updater.ts",
    "workspace-boundary.ts", "markdown-mirror.ts",
  ],
  operator: [
    "adapters/openclaw/runtime-rollout-control.ts",
    "cli/auth-commands.ts", "cli/auth-config-transaction.ts", "cli/cli-runtime-policy.ts",
    "cli/diagnostic-commands.ts", "cli/principal-commands.ts",
    "cli/experience-commands.ts", "cli/governance-commands.ts", "cli/memory-commands.ts",
    "cli/migration-commands.ts", "diagnostics-redaction.ts", "migrate.ts",
    "memory-compactor.ts", "operator-dashboard.ts", "release-provenance.ts", "runtime-diagnostic-receipt.ts", "self-improvement-files.ts",
  ],
  compat: ["adapters/openclaw/runtime-shadow.ts", "clawteam-scope.ts", "markdown-compat.ts"],
};

const ROOT_ALLOWED_DEPENDENCIES = {
  composition: new Set(["composition", "domain", "application", "adapters", "infrastructure", "operator", "compat"]),
  domain: new Set(["domain"]),
  application: new Set(["application", "domain"]),
  adapters: new Set(["adapters", "application", "domain"]),
  infrastructure: new Set(["infrastructure", "application", "domain"]),
  operator: new Set(["operator", "infrastructure", "application", "domain"]),
  compat: new Set(["compat", "adapters", "application", "infrastructure", "domain"]),
};

const V2_LAYER_TO_ROOT_LAYER = {
  domain: "domain",
  application: "application",
  storage: "infrastructure",
  workers: "application",
  adapters: "adapters",
  migration: "operator",
  operator: "operator",
  eval: "adapters",
};

// Exact migration debt. New reverse edges fail immediately; removing an edge
// requires deleting its ledger entry in the same reviewed change.
const ROOT_REVERSE_DEPENDENCY_DEBT = new Set([
  "src/access-tracker.ts -> src/store.ts",
  "src/admission-control.ts -> src/llm-client.ts",
  "src/admission-control.ts -> src/store.ts",
  "src/conflict-governance.ts -> src/store.ts",
  "src/digest-pipeline.ts -> src/llm-client.ts",
  "src/digest-pipeline.ts -> src/store.ts",
  "src/experience-promotion-batch.ts -> src/experience-store.ts",
  "src/experience-replay.ts -> src/experience-store.ts",
  "src/experience-tools.ts -> src/embedder.ts",
  "src/experience-tools.ts -> src/journal-recovery.ts",
  "src/experience-tools.ts -> src/operator-dashboard.ts",
  "src/experience-tools.ts -> src/store.ts",
  "src/experience-tools.ts -> src/workspace-boundary.ts",
  "src/memory-upgrader.ts -> src/llm-client.ts",
  "src/memory-upgrader.ts -> src/store.ts",
  "src/noise-prototypes.ts -> src/embedder.ts",
  "src/retriever.ts -> src/embedder.ts",
  "src/retriever.ts -> src/store.ts",
  "src/smart-extractor.ts -> src/embedder.ts",
  "src/smart-extractor.ts -> src/llm-client.ts",
  "src/smart-extractor.ts -> src/store.ts",
  "src/task-experience.ts -> src/embedder.ts",
  "src/task-experience.ts -> src/llm-client.ts",
  "src/task-experience.ts -> src/store.ts",
  "src/tools.ts -> src/artifacts.ts",
  "src/tools.ts -> src/embedder.ts",
  "src/tools.ts -> src/secret-index.ts",
  "src/tools.ts -> src/self-improvement-files.ts",
  "src/tools.ts -> src/store.ts",
]);

// Splitting a debt-bearing adapter must not manufacture new logical debt just
// because one old source file became several capability files. These aliases
// keep the ledger attached to the stable Agent-tool subsystem while each
// physical module remains independently classified and line-budgeted.
const ROOT_DEBT_SOURCE_ALIASES = new Map([
  ["src/experience-episode-tools.ts", "src/experience-tools.ts"],
  ["src/experience-operator-tools.ts", "src/experience-tools.ts"],
  ["src/experience-playbook-tools.ts", "src/experience-tools.ts"],
  ["src/experience-query-tools.ts", "src/experience-tools.ts"],
  ["src/experience-review-tools.ts", "src/experience-tools.ts"],
  ["src/experience-tool-runtime-policy.ts", "src/experience-tools.ts"],
  ["src/memory-diagnostic-tools.ts", "src/tools.ts"],
  ["src/memory-governance-tools.ts", "src/tools.ts"],
  ["src/memory-lifecycle-tools.ts", "src/tools.ts"],
  ["src/memory-recall-tools.ts", "src/tools.ts"],
  ["src/memory-write-tools.ts", "src/tools.ts"],
  ["src/self-improvement-tools.ts", "src/tools.ts"],
  ["src/tool-runtime-policy.ts", "src/tools.ts"],
]);

const V2_LAYERS = new Set([
  "adapters", "application", "domain", "eval", "migration", "operator",
  "storage", "workers",
]);

const HOTSPOT_LINE_BUDGETS = new Map([
  ["index.ts", 632],
  ["src/store.ts", 2_010],
  ["src/sql-truth-store.ts", 1_514],
  ["src/smart-extractor.ts", 1_427],
  ["src/retriever.ts", 1_425],
  ["src/embedder.ts", 1_309],
  ["src/experience-store.ts", 1_072],
  ["src/digest-pipeline.ts", 825],
  ["src/llm-oauth.ts", 810],
  ["src/v2/operator/live-candidate-companion-disposition.ts", 880],
  ["src/v2/operator/live-candidate-duplicate-archive.ts", 1_171],
  ["src/v2/operator/live-candidate-durable-rewrite-apply.ts", 805],
  ["src/v2/operator/live-candidate-unsafe-trace-rewrite-apply.ts", 1_011],
  ["src/v2/operator/live-post-assignment-candidate-plan.ts", 807],
]);

const LEGACY_BRAND_BUDGETS = new Map([
  ["openclaw.plugin.json", 3],
  ["package.json", 1],
  ["scripts/packed-legacy-identity-smoke.mjs", 4],
  ["scripts/packed-runtime-smoke.mjs", 1],
  ["scripts/release-gate.mjs", 3],
  ["src/experience-promotion.ts", 1],
  ["src/product-identity.ts", 5],
  ["src/runtime-config.ts", 2],
  ["src/v2/domain/release.ts", 3],
]);

function createRootLayerMap() {
  const result = new Map();
  for (const [layer, paths] of Object.entries(ROOT_MODULES_BY_LAYER)) {
    for (const path of paths) result.set(`src/${path}`, layer);
  }
  return result;
}

test("every production TypeScript module has an architecture classification", async () => {
  const classified = new Map([
    ["index.ts", "composition"],
    ["cli.ts", "adapters"],
  ]);
  for (const [layer, paths] of Object.entries(ROOT_MODULES_BY_LAYER)) {
    for (const path of paths) {
      const key = `src/${path}`;
      assert.equal(classified.has(key), false, `duplicate architecture classification: ${key}`);
      classified.set(key, layer);
    }
  }

  for (const path of await filesUnder(srcRoot, ".ts")) {
    const key = relative(root, path).replaceAll("\\", "/");
    if (key.startsWith("src/v2/")) {
      const layer = key.split("/")[2];
      assert.equal(V2_LAYERS.has(layer), true, `unclassified current-architecture layer: ${key}`);
      classified.set(key, layer);
    }
  }

  const actual = ["index.ts", "cli.ts", ...(await filesUnder(srcRoot, ".ts"))
    .map((path) => relative(root, path).replaceAll("\\", "/"))]
    .sort();
  assert.deepEqual([...classified.keys()].sort(), actual);
});

test("migration-era root reverse dependencies match the shrink-only debt ledger", async () => {
  const layerByPath = createRootLayerMap();
  const observedDebt = new Set();

  for (const [sourcePath, fromLayer] of layerByPath) {
    if (sourcePath.endsWith(".d.ts")) continue;
    const source = await readFile(resolve(sourcePath), "utf8");
    for (const specifier of importedSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const targetPath = relative(
        root,
        resolve(dirname(resolve(sourcePath)), specifier.replace(/\.js$/, ".ts")),
      ).replaceAll("\\", "/");
      const v2Layer = targetPath.startsWith("src/v2/")
        ? V2_LAYER_TO_ROOT_LAYER[targetPath.split("/")[2]]
        : undefined;
      const toLayer = layerByPath.get(targetPath) ?? v2Layer;
      if (!toLayer) continue;
      assert.ok(ROOT_ALLOWED_DEPENDENCIES[fromLayer], `missing dependency policy for ${fromLayer}`);
      if (!ROOT_ALLOWED_DEPENDENCIES[fromLayer].has(toLayer)) {
        const debtSource = ROOT_DEBT_SOURCE_ALIASES.get(sourcePath) ?? sourcePath;
        observedDebt.add(`${debtSource} -> ${targetPath}`);
      }
    }
  }

  assert.deepEqual([...observedDebt].sort(), [...ROOT_REVERSE_DEPENDENCY_DEBT].sort());
});

test("memory_truth DML is confined to the mutation allowlist and synchronizes lifecycle projection", async () => {
  const allowed = new Set([
    "src/candidate-promotion.ts",
    "src/forgetting.ts",
    "src/governance-cleanup.ts",
    "src/sql-truth-store.ts",
    "src/v2/operator/live-principal-scope-apply.ts",
  ]);
  const dml = /\b(?:UPDATE\s+memory_truth|DELETE\s+FROM\s+memory_truth|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+memory_truth)\b/i;
  const observed = [];
  for (const path of await filesUnder(srcRoot, ".ts")) {
    const source = await readFile(path, "utf8");
    if (!dml.test(source)) continue;
    const key = relative(root, path).replaceAll("\\", "/");
    observed.push(key);
    assert.equal(allowed.has(key), true, `memory_truth DML outside mutation allowlist: ${key}`);
    if (key !== "src/sql-truth-store.ts") {
      assert.match(source, /syncLifecycleProjectionFromTruth/,
        `raw mutation path must synchronize lifecycle projection: ${key}`);
    }
  }
  assert.deepEqual(observed.sort(), [...allowed].sort());

  const migration = await readFile(resolve("scripts/migrate-legacy-hygiene.mjs"), "utf8");
  assert.match(migration, dml);
  assert.match(migration, /syncLifecycleProjectionFromTruth/);
});

test("existing TypeScript hotspots cannot grow and new modules stay below 800 lines", async () => {
  const paths = [resolve("index.ts"), resolve("cli.ts"), ...await filesUnder(srcRoot, ".ts")];
  const violations = [];
  for (const path of paths) {
    if (path.endsWith(".d.ts")) continue;
    const key = relative(root, path).replaceAll("\\", "/");
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).length - 1;
    const maximum = HOTSPOT_LINE_BUDGETS.get(key) ?? 800;
    if (lines > maximum) violations.push(`${key}: ${lines} > ${maximum}`);
  }
  assert.deepEqual(violations, []);
});

test("legacy brand spellings are confined to an explicit non-growth ledger", async () => {
  const candidates = [
    resolve("index.ts"), resolve("cli.ts"), resolve("openclaw.plugin.json"),
    resolve("package.json"), ...await filesUnder(srcRoot, ".ts"),
    ...await filesUnder(resolve("scripts"), ".mjs"),
  ];
  const pattern = /scope-recall-openclaw|["'`]scope-recall["'`]|clawloreV2|clawlore-v2:/g;
  const observed = new Map();
  for (const path of candidates) {
    const source = await readFile(path, "utf8");
    const count = [...source.matchAll(pattern)].length;
    if (count > 0) observed.set(relative(root, path).replaceAll("\\", "/"), count);
  }

  const violations = [];
  for (const [path, count] of observed) {
    const maximum = LEGACY_BRAND_BUDGETS.get(path);
    if (maximum === undefined) violations.push(`${path}: unclassified legacy branding (${count})`);
    else if (count > maximum) violations.push(`${path}: ${count} > ${maximum}`);
  }
  assert.deepEqual(violations, []);
});
