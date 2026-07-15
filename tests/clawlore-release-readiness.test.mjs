import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { releaseProvenance } from "./fixtures/release-provenance.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { validateCompatibilitySurface, buildReleaseReadinessReceipt } = jiti("../src/v2/application/release-readiness.ts");
const { buildSupportBundleV1 } = jiti("../src/v2/operator/support-bundle.ts");

function evidence(overrides = {}) {
  return {
    focusedTests: true, fullTests: true, typecheck: true, build: true,
    moduleBoundaries: true, releaseGate: true, snapshotVerified: true,
    migrationDrill: true, rollbackDrill: true, legacyHashUnchanged: true,
    forbiddenScopeViolations: 0,
    ...overrides,
  };
}

test("release compatibility keeps package, manifest, CLI alias, config, and data identities", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const manifest = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
  const failures = validateCompatibilitySurface({
    packageName: pkg.name,
    manifestId: manifest.id,
    manifestLegacyPluginIds: manifest.legacyPluginIds,
    manifestCommands: manifest.commandAliases.map((command) => command.name),
  });
  assert.deepEqual(failures, []);
});

test("rollout preview is default-off, mode-aware, and quality-gated", () => {
  const blocked = buildReleaseReadinessReceipt({
    rolloutId: "rollout-blocked", requestedMode: "cutover", currentMode: "disabled",
    evidence: evidence({ rollbackDrill: false, forbiddenScopeViolations: 1 }),
    provenance: releaseProvenance({ lifecycle: { active: 0, candidate: 10, archived: 1, other: 0 } }),
    now: () => new Date("2026-07-12T02:00:00Z"),
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.rollout.blockingReasons.includes("gate_failed:rollbackDrill"));
  assert.ok(blocked.rollout.blockingReasons.includes("forbidden_scope_violation"));
  assert.ok(blocked.rollout.blockingReasons.includes("lifecycle_active_empty"));
  assert.equal("requiresOperatorApproval" in blocked.rollout, false);
  assert.equal(blocked.rollout.steps[0].mutatesLive, false);

  const shadow = buildReleaseReadinessReceipt({
    rolloutId: "rollout-shadow", requestedMode: "shadow", currentMode: "disabled",
    evidence: evidence({ snapshotVerified: false, migrationDrill: false, rollbackDrill: false, legacyHashUnchanged: false }),
    provenance: releaseProvenance(),
  });
  assert.equal(shadow.status, "ready");
  assert.equal(shadow.rollout.readOnly, true);
  assert.equal("requiresOperatorApproval" in shadow.rollout, false);

  const cutover = buildReleaseReadinessReceipt({
    rolloutId: "rollout-ready", requestedMode: "cutover", currentMode: "shadow", evidence: evidence(),
    provenance: releaseProvenance(),
  });
  assert.equal(cutover.status, "ready");
  assert.equal(cutover.rollout.readOnly, false);
  assert.ok(cutover.rollout.steps.some((step) => step.action.includes("atomic_cutover")));
  assert.deepEqual(cutover.responseSchemas, [
    "memory-action.v2", "memory-center.v1", "projection-convergence.v1", "replay-evaluation.v2",
  ]);

  const emptyParity = buildReleaseReadinessReceipt({
    rolloutId: "rollout-empty-parity",
    requestedMode: "cutover",
    currentMode: "shadow",
    evidence: evidence(),
    provenance: releaseProvenance({
      lifecycle: { active: 0, candidate: 569, archived: 436, other: 0 },
      shadow: {
        sampleCount: 12, directSamples: 12, groupSamples: 0,
        positiveCandidateSamples: 0, overlapRatio: 0, rankAgreement: 0,
        p95LatencyMs: 50, forbiddenViolations: 0, promptBudgetViolations: 0,
      },
    }),
  });
  assert.equal(emptyParity.status, "blocked");
  assert.ok(emptyParity.rollout.blockingReasons.includes("lifecycle_active_empty"));
  assert.ok(emptyParity.rollout.blockingReasons.includes("shadow_positive_samples_below_10"));
  assert.ok(emptyParity.rollout.blockingReasons.includes("shadow_overlap_below_0_8"));
});

test("support bundle redacts credentials, authorization, private keys, and local paths", () => {
  const bundle = buildSupportBundleV1({
    pluginVersion: "1.1.0",
    runtimeMode: "shadow",
    generatedAt: "2026-07-12T02:00:00Z",
    diagnostics: {
      apiKey: "must-not-appear",
      nested: { Authorization: "Bearer abcdefghijklmnop", safe: "fts-only" },
      privateMaterial: "-----BEGIN PRIVATE KEY-----\nsecret",
      dbPath: "/home/example/.openclaw/memory.sqlite",
    },
  });
  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.includes("must-not-appear"), false);
  assert.equal(serialized.includes("abcdefghijklmnop"), false);
  assert.equal(serialized.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(serialized.includes("/home/example"), false);
  assert.equal(bundle.diagnostics.nested.safe, "fts-only");
});
