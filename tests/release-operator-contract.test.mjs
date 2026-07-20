import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleaseDoctor,
  releaseGateEnvironment,
} from "../scripts/release-operator-contract.mjs";

test("release wrapper accepts explicit principal and target remote ref", () => {
  const env = releaseGateEnvironment([
    "--principal", "telegram:default:12345",
    "--release-ref", "refs/tags/v1.2.0",
  ], { PATH: "/bin" });
  assert.equal(env.CLAWLORE_RUNTIME_PRINCIPAL, "telegram:default:12345");
  assert.equal(env.CLAWLORE_RELEASE_REF, "refs/tags/v1.2.0");
  assert.throws(
    () => releaseGateEnvironment(["--principal", "telegram:default:*"]),
    /exact platform:account:principal/,
  );
  assert.throws(
    () => releaseGateEnvironment([], { CLAWLORE_RUNTIME_PRINCIPAL: "telegram:default:*" }),
    /exact platform:account:principal/,
  );
  assert.throws(
    () => releaseGateEnvironment(["--release-ref", "refs/heads/release..bad"]),
    /exact refs\/heads/,
  );
});

test("pre-push mode is explicitly non-authorizing and cannot claim a release ref", () => {
  const env = releaseGateEnvironment(["--pre-push"], { PATH: "/bin" });
  assert.equal(env.CLAWLORE_PRE_PUSH, "1");
  assert.equal(env.CLAWLORE_SOURCE_ONLY, "1");
  assert.equal(env.CLAWLORE_RELEASE_REF, undefined);
  assert.throws(
    () => releaseGateEnvironment(["--pre-push", "--release-ref", "refs/heads/main"]),
    /does not verify publication/,
  );
});

test("release doctor gives a directed error when an allowlist principal is missing", () => {
  assert.throws(
    () => assertReleaseDoctor({
      report: { ok: false, runtimeAccessibility: { status: "principal_required" } },
      status: 1,
      principal: "",
    }),
    /rerun with --principal platform:account:principal/,
  );
});

test("release doctor accepts a matching principal and blocks a mismatched one", () => {
  const ready = { ok: true, runtimeAccessibility: { status: "ready" } };
  assert.equal(assertReleaseDoctor({ report: ready, status: 0, principal: "telegram:default:12345" }), ready);
  assert.throws(
    () => assertReleaseDoctor({
      report: { ok: false, runtimeAccessibility: { status: "migration_required" } },
      status: 1,
      principal: "telegram:default:other",
    }),
    /supplied principal cannot access recallable legacy rows/,
  );
});
