import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { enforcePrivatePath } = jiti("../src/file-privacy.ts");

test("POSIX private path adapter tightens file and directory modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-private-path-"));
  const file = join(dir, "secret.json");
  try {
    writeFileSync(file, "fixture\n", { mode: 0o644 });
    chmodSync(dir, 0o755);
    enforcePrivatePath(dir, { kind: "directory", platform: "linux" });
    enforcePrivatePath(file, { kind: "file", platform: "linux" });
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows private path adapter removes broad grants and verifies protected DACL", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-private-windows-"));
  const file = join(dir, "secret.json");
  const calls = [];
  try {
    writeFileSync(file, "fixture\n");
    const fakeExec = (command, args) => {
      calls.push([command, args]);
      if (command === "whoami.exe") return '"HOST\\joy","S-1-5-21-1000"\r\n';
      if (command === "powershell.exe") return "O:S-1-5-21-1000D:P(A;;FA;;;S-1-5-21-1000)";
      return "processed 1 files";
    };
    enforcePrivatePath(file, { platform: "win32", execFile: fakeExec });
    const aclCall = calls.find(([command]) => command === "icacls.exe");
    assert.ok(aclCall);
    assert.ok(aclCall[1].includes("/inheritance:r"));
    assert.ok(aclCall[1].includes("*S-1-1-0"));
    assert.ok(aclCall[1].includes("*S-1-5-11"));
    assert.ok(aclCall[1].includes("*S-1-5-32-545"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows private path adapter fails when broad allow ACE remains", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-private-windows-fail-"));
  const file = join(dir, "secret.json");
  try {
    writeFileSync(file, "fixture\n");
    const fakeExec = (command) => {
      if (command === "whoami.exe") return '"HOST\\joy","S-1-5-21-1000"\r\n';
      if (command === "powershell.exe") return "O:S-1-5-21-1000D:P(A;;FA;;;WD)";
      return "processed 1 files";
    };
    assert.throws(
      () => enforcePrivatePath(file, { platform: "win32", execFile: fakeExec }),
      /CLAWLORE_WINDOWS_ACL_VERIFICATION_FAILED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
