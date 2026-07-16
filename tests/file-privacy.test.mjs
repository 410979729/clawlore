import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { enforcePrivatePath, ensurePrivateDirectory, verifyPrivatePath } = jiti("../src/file-privacy.ts");

test("POSIX private path adapter tightens file and directory modes", {
  skip: process.platform === "win32",
}, () => {
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

test("private directory creation builds only the missing dedicated suffix", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-private-tree-"));
  const nested = join(root, "memory", "clawlore");
  try {
    chmodSync(root, 0o700);
    ensurePrivateDirectory(nested, { platform: "linux" });
    assert.equal(existsSync(nested), true);
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(root, "memory")).mode & 0o777, 0o700);
    assert.equal(lstatSync(nested).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private directory creation accepts a non-writable 0755 ancestor without rewriting it", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-private-public-parent-"));
  try {
    chmodSync(root, 0o755);
    ensurePrivateDirectory(join(root, "memory", "clawlore"), { platform: "linux" });
    assert.equal(lstatSync(root).mode & 0o777, 0o755);
    assert.equal(lstatSync(join(root, "memory")).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(root, "memory", "clawlore")).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private directory creation rejects a group-writable ancestor without rewriting it", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-private-writable-parent-"));
  try {
    chmodSync(root, 0o775);
    assert.throws(
      () => ensurePrivateDirectory(join(root, "memory", "clawlore"), { platform: "linux" }),
      /CLAWLORE_PRIVATE_PATH_ANCESTOR_WRITABLE/,
    );
    assert.equal(lstatSync(root).mode & 0o777, 0o775);
    assert.equal(existsSync(join(root, "memory")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows private path adapter removes broad grants and verifies protected DACL", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-private-windows-"));
  const file = join(dir, "secret.json");
  const calls = [];
  try {
    writeFileSync(file, "fixture\n");
    const fakeExec = (command, args, options) => {
      calls.push([command, args, options]);
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
    assert.deepEqual(aclCall[1].slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(aclCall[1][3], "base64").toString("utf16le");
    assert.match(script, /SetOwner/);
    assert.match(script, /SetAccessRuleProtection/);
    assert.match(script, /RemoveAccessRuleSpecific/);
    assert.equal(aclCall[2].env.CLAWLORE_PRIVATE_PATH, file);
    assert.equal(aclCall[2].env.CLAWLORE_PRIVATE_SID, "S-1-5-21-1000");
    assert.equal(aclCall[2].env.CLAWLORE_PRIVATE_KIND, "file");
    assert.equal(aclCall[2].env.CLAWLORE_PRIVATE_MODE, "enforce");
    assert.equal(argsContainRawPath(aclCall[1], file), false, "path must not be interpolated into PowerShell source/argv");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function argsContainRawPath(args, path) {
  return args.some((arg) => String(arg).includes(path));
}

test("Windows private path verification uses the same real-process encoded command without mutating ACL", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-private-windows-verify-"));
  const file = join(dir, "secret [中文].json");
  const calls = [];
  try {
    writeFileSync(file, "fixture\n");
    const fakeExec = (command, args, options) => {
      calls.push([command, args, options]);
      if (command === "whoami.exe") return '"HOST\\joy","S-1-5-21-1000"\r\n';
      return JSON.stringify({
        ownerSid: "S-1-5-21-1000",
        protected: true,
        access: [{ sid: "S-1-5-21-1000", type: "Allow", rights: "FullControl", inherited: false }],
      });
    };
    verifyPrivatePath(file, { platform: "win32", execFile: fakeExec });
    const aclCall = calls.find(([command]) => command === "powershell.exe");
    assert.equal(aclCall[2].env.CLAWLORE_PRIVATE_MODE, "verify");
    assert.equal(aclCall[2].env.CLAWLORE_PRIVATE_PATH, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows real PowerShell ACL helper accepts structured environment inputs", {
  skip: process.platform !== "win32",
}, () => {
  const dir = mkdtempSync(join(homedir(), "clawlore real acl 中文 [fixture] "));
  const privateDir = join(dir, "memory", "clawlore");
  const file = join(privateDir, "secret file.json");
  try {
    ensurePrivateDirectory(privateDir, { platform: "win32" });
    writeFileSync(file, "fixture\n");
    enforcePrivatePath(file, { platform: "win32", kind: "file" });
    verifyPrivatePath(privateDir, { platform: "win32", kind: "directory" });
    verifyPrivatePath(file, { platform: "win32", kind: "file" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows directory creation accepts trusted inherited ancestor ACLs and hardens only the suffix", () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-private-windows-ancestor-"));
  const nested = join(root, "memory", "clawlore");
  const calls = [];
  try {
    const fakeExec = (command, _args, options) => {
      if (command === "whoami.exe") return '"HOST\\joy","S-1-5-21-1000"\r\n';
      if (command !== "powershell.exe") throw new Error(`unexpected command ${command}`);
      calls.push({ path: options.env.CLAWLORE_PRIVATE_PATH, mode: options.env.CLAWLORE_PRIVATE_MODE });
      if (options.env.CLAWLORE_PRIVATE_MODE === "verify") {
        return JSON.stringify({
          ownerSid: "S-1-5-21-1000",
          protected: false,
          access: [
            { sid: "S-1-5-21-1000", type: "Allow", rights: "FullControl", inherited: true },
            { sid: "S-1-5-18", type: "Allow", rights: "FullControl", inherited: true },
            { sid: "S-1-5-32-544", type: "Allow", rights: "FullControl", inherited: true },
            { sid: "S-1-5-32-545", type: "Allow", rights: "ReadAndExecute, Synchronize", inherited: true },
          ],
        });
      }
      return JSON.stringify({
        ownerSid: "S-1-5-21-1000",
        protected: true,
        access: [{ sid: "S-1-5-21-1000", type: "Allow", rights: "FullControl", inherited: false }],
      });
    };
    ensurePrivateDirectory(nested, { platform: "win32", execFile: fakeExec });
    assert.equal(existsSync(nested), true);
    assert.deepEqual(calls.filter((call) => call.mode === "verify").map((call) => call.path), [root]);
    assert.deepEqual(calls.filter((call) => call.mode === "enforce").map((call) => call.path), [
      join(root, "memory"),
      nested,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows directory creation rejects an ancestor writable by an untrusted principal", () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-private-windows-untrusted-"));
  try {
    const fakeExec = (command) => {
      if (command === "whoami.exe") return '"HOST\\joy","S-1-5-21-1000"\r\n';
      return JSON.stringify({
        ownerSid: "S-1-5-21-1000",
        protected: false,
        access: [
          { sid: "S-1-5-21-1000", type: "Allow", rights: "FullControl", inherited: true },
          { sid: "S-1-5-32-545", type: "Allow", rights: "Modify", inherited: true },
        ],
      });
    };
    assert.throws(
      () => ensurePrivateDirectory(join(root, "memory", "clawlore"), { platform: "win32", execFile: fakeExec }),
      /CLAWLORE_WINDOWS_ACL_ANCESTOR_UNTRUSTED/,
    );
    assert.equal(existsSync(join(root, "memory")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
