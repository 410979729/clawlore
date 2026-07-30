import assert from "node:assert/strict";
import test from "node:test";

import {
  openClawCliForPackage,
  resolveOpenClawCliTarget,
  resolveOpenClawPackageTarget,
} from "../scripts/openclaw-cli-target.mjs";

function packageExists(expectedRoot) {
  return (path) => [
    `${expectedRoot}\\package.json`,
    `${expectedRoot}\\openclaw.mjs`,
  ].includes(path);
}

test("OpenClaw package resolution supports sibling Windows state and app roots", () => {
  const expected = "C:\\runtime\\instance\\app\\node_modules\\openclaw";
  assert.equal(
    resolveOpenClawPackageTarget({
      platform: "win32",
      stateDir: "C:\\runtime\\instance\\state",
      exists: packageExists(expected),
    }),
    expected,
  );
  assert.equal(
    openClawCliForPackage(expected, { platform: "win32" }),
    "C:\\runtime\\instance\\app\\node_modules\\.bin\\openclaw.cmd",
  );
});

test("OpenClaw package resolution supports nested Linux home/state layout", () => {
  const expected = "/srv/instance/app/node_modules/openclaw";
  const exists = (path) => [
    `${expected}/package.json`,
    `${expected}/openclaw.mjs`,
  ].includes(path);
  assert.equal(
    resolveOpenClawPackageTarget({
      platform: "linux",
      stateDir: "/srv/instance/home/state",
      exists,
    }),
    expected,
  );
  assert.equal(
    openClawCliForPackage(expected, { platform: "linux" }),
    "/srv/instance/app/node_modules/.bin/openclaw",
  );
});

test("explicit OpenClaw package and CLI targets take precedence over layout inference", () => {
  const packageRoot = "C:\\custom\\node_modules\\openclaw";
  assert.equal(
    resolveOpenClawPackageTarget({
      platform: "win32",
      stateDir: "C:\\runtime\\state",
      configuredPackage: packageRoot,
      exists: packageExists(packageRoot),
    }),
    packageRoot,
  );
  assert.equal(
    resolveOpenClawPackageTarget({
      platform: "win32",
      stateDir: "C:\\runtime\\state",
      configuredCli: "C:\\custom\\node_modules\\.bin\\openclaw.cmd",
      exists: packageExists(packageRoot),
    }),
    packageRoot,
  );
});

test("OpenClaw package inference fails closed when absent or ambiguous", () => {
  assert.throws(
    () => resolveOpenClawPackageTarget({
      platform: "win32",
      stateDir: "C:\\runtime\\state",
      exists: () => false,
    }),
    /package is missing/,
  );
  const sibling = "C:\\runtime\\app\\node_modules\\openclaw";
  const nested = "C:\\app\\node_modules\\openclaw";
  assert.throws(
    () => resolveOpenClawPackageTarget({
      platform: "win32",
      stateDir: "C:\\runtime\\state",
      exists: (path) => [
        `${sibling}\\package.json`,
        `${sibling}\\openclaw.mjs`,
        `${nested}\\package.json`,
        `${nested}\\openclaw.mjs`,
      ].includes(path),
    }),
    /inference is ambiguous/,
  );
});

test("Windows OpenClaw npm shim resolves to the package entry without a shell", () => {
  const command = "C:\\runtime\\node_modules\\.bin\\openclaw.cmd";
  const expectedEntry = "C:\\runtime\\node_modules\\openclaw\\openclaw.mjs";
  const target = resolveOpenClawCliTarget(command, ["plugins", "list"], {
    platform: "win32",
    nodeExecutable: "C:\\node\\node.exe",
    exists: (path) => path === expectedEntry,
  });
  assert.deepEqual(target, {
    command: "C:\\node\\node.exe",
    args: [expectedEntry, "plugins", "list"],
  });
});

test("Windows OpenClaw shim resolution fails closed for unknown or missing entries", () => {
  assert.throws(
    () => resolveOpenClawCliTarget("C:\\runtime\\other.cmd", [], {
      platform: "win32",
      exists: () => true,
    }),
    /unsupported Windows OpenClaw command shim/,
  );
  assert.throws(
    () => resolveOpenClawCliTarget("C:\\runtime\\node_modules\\.bin\\openclaw.cmd", [], {
      platform: "win32",
      exists: () => false,
    }),
    /Windows OpenClaw package entry is missing/,
  );
});

test("JavaScript and native OpenClaw commands preserve shell-free targets", () => {
  assert.deepEqual(
    resolveOpenClawCliTarget("/runtime/openclaw.mjs", ["status"], {
      platform: "linux",
      nodeExecutable: "/usr/bin/node",
    }),
    { command: "/usr/bin/node", args: ["/runtime/openclaw.mjs", "status"] },
  );
  assert.deepEqual(
    resolveOpenClawCliTarget("/usr/bin/openclaw", ["status"], { platform: "linux" }),
    { command: "/usr/bin/openclaw", args: ["status"] },
  );
});
