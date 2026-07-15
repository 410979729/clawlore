import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { assertDependencyTree, inspectDependencyTree } from "../scripts/dependency-preflight.mjs";
import { interpretAuditResult } from "../scripts/supply-chain-audit.mjs";

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

test("model-visible tool catches do not interpolate raw exception strings", () => {
  for (const relative of ["../src/tools.ts", "../src/experience-tools.ts"]) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    for (const forbidden of ["String(error)", "${error}", "error.message"]) {
      assert.equal(source.includes(forbidden), false, `${relative} exposes ${forbidden}`);
    }
    assert.match(source, /diagnosticErrorSummary/);
  }

  const canary = "sk-private-canary /home/private/user.txt original user text";
  for (const payload of [
    safeToolFailure("recall_failed", "Memory recall failed", new Error(canary)),
    safeExperienceToolFailure("playbook_search_failed", "Playbook search failed", new Error(canary)),
  ]) {
    assert.equal(JSON.stringify(payload).includes(canary), false);
    assert.equal(payload.isError, true);
  }
});
