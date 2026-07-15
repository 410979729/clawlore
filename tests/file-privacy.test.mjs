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
      if (command === "powershell.exe") return JSON.stringify({
        ownerSid: "S-1-5-21-1000",
        protected: true,
        access: [{
          sid: "S-1-5-21-1000",
          type: "Allow",
          rights: "FullControl",
          inherited: false,
          inheritanceFlags: "None",
          propagationFlags: "None",
        }],
      });
      throw new Error(`unexpected command ${command}`);
    };
    enforcePrivatePath(file, { platform: "win32", execFile: fakeExec });
    const aclCall = calls.find(([command]) => command === "powershell.exe");
    assert.ok(aclCall);
    assert.match(aclCall[1][3], /SetOwner/);
    assert.match(aclCall[1][3], /SetAccessRuleProtection/);
    assert.match(aclCall[1][3], /RemoveAccessRuleSpecific/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "owner is unknown",
    report: {
      ownerSid: "S-1-5-21-9999",
      protected: true,
      access: [{ sid: "S-1-5-21-1000", type: "Allow", rights: "FullControl", inherited: false }],
    },
  },
  {
    name: "an unknown SID keeps read access",
    report: {
      ownerSid: "S-1-5-21-1000",
      protected: true,
      access: [
        { sid: "S-1-5-21-1000", type: "Allow", rights: "FullControl", inherited: false },
        { sid: "S-1-5-21-9999", type: "Allow", rights: "ReadAndExecute", inherited: false },
      ],
    },
  },
  {
    name: "an inherited group ACE remains",
    report: {
      ownerSid: "S-1-5-21-1000",
      protected: true,
      access: [
        { sid: "S-1-5-21-1000", type: "Allow", rights: "FullControl", inherited: false },
        { sid: "S-1-5-32-544", type: "Allow", rights: "FullControl", inherited: true },
      ],
    },
  },
  {
    name: "DACL is not protected",
    report: {
      ownerSid: "S-1-5-21-1000",
      protected: false,
      access: [{ sid: "S-1-5-21-1000", type: "Allow", rights: "FullControl", inherited: false }],
    },
  },
]) test(`Windows private path adapter fails when ${scenario.name}`, () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-private-windows-fail-"));
  const file = join(dir, "secret.json");
  try {
    writeFileSync(file, "fixture\n");
    const fakeExec = (command) => {
      if (command === "whoami.exe") return '"HOST\\joy","S-1-5-21-1000"\r\n';
      if (command === "powershell.exe") return JSON.stringify(scenario.report);
      throw new Error(`unexpected command ${command}`);
    };
    assert.throws(
      () => enforcePrivatePath(file, { platform: "win32", execFile: fakeExec }),
      /CLAWLORE_WINDOWS_ACL_VERIFICATION_FAILED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
