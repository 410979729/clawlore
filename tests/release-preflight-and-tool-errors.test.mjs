import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { assertDependencyTree, inspectDependencyTree } from "../scripts/dependency-preflight.mjs";
import { interpretAuditResult } from "../scripts/supply-chain-audit.mjs";
import { assertReleaseSourceState } from "../scripts/release-source-state.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { safeToolFailure } = jiti("../src/tools.ts");
const { safeExperienceToolFailure } = jiti("../src/experience-tools.ts");

test("dependency preflight distinguishes an incomplete install from product test failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-dependency-preflight-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "missing-dependency-fixture",
      version: "1.0.0",
      dependencies: { "clawlore-definitely-missing-package": "1.0.0" },
    }));
    assert.equal(inspectDependencyTree(dir).ok, false);
    assert.throws(() => assertDependencyTree(dir), /dependency preflight failed.*npm ci/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit endpoint failures are release failures, never zero-vulnerability success", () => {
  assert.deepEqual(
    interpretAuditResult({ status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) }),
    { ok: false, vulnerabilities: null, reason: "audit_endpoint_or_transport_failure" },
  );
  assert.deepEqual(
    interpretAuditResult({ status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }) }),
    { ok: true, vulnerabilities: 0, reason: null },
  );
});

test("source-only and live release gates both reject post-build dirty trees", () => {
  assert.doesNotThrow(() => assertReleaseSourceState({ gitDirty: false, sourceOnly: true }));
  assert.throws(
    () => assertReleaseSourceState({ gitDirty: true, sourceOnly: true }),
    /source-only.*post-build candidate worktree.*clean/,
  );
  assert.throws(
    () => assertReleaseSourceState({ gitDirty: true, sourceOnly: false }),
    /live-artifact.*post-build candidate worktree.*clean/,
  );
});

test("model-visible tool catches do not interpolate raw exception strings", () => {
  const relatives = [
    "../src/tool-runtime-policy.ts",
    "../src/self-improvement-tools.ts",
    "../src/memory-recall-tools.ts",
    "../src/memory-write-tools.ts",
    "../src/memory-lifecycle-tools.ts",
    "../src/memory-diagnostic-tools.ts",
    "../src/memory-governance-tools.ts",
    "../src/experience-tool-runtime-policy.ts",
    "../src/experience-episode-tools.ts",
    "../src/experience-playbook-tools.ts",
    "../src/experience-query-tools.ts",
    "../src/experience-operator-tools.ts",
    "../src/experience-review-tools.ts",
  ];
  const sources = [];
  for (const relative of relatives) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    sources.push(source);
    for (const forbidden of [
      "String(error)",
      "${error}",
      "error.message",
      "String(err)",
      "${err}",
      "err.message",
    ]) {
      assert.equal(source.includes(forbidden), false, `${relative} exposes ${forbidden}`);
    }
  }
  assert.match(sources.join("\n"), /diagnosticErrorSummary/);

  const canary = "sk-private-canary /home/private/user.txt original user text";
  for (const payload of [
    safeToolFailure("recall_failed", "Memory recall failed", new Error(canary)),
    safeExperienceToolFailure("playbook_search_failed", "Playbook search failed", new Error(canary)),
  ]) {
    assert.equal(JSON.stringify(payload).includes(canary), false);
    assert.equal(payload.isError, true);
  }
});
