import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const CHILD_SCRIPT = String.raw`
import { writeFileSync } from "node:fs";

const [moduleUrl, lockPath, readyPath, role] = process.argv.slice(1);
const { withPrivateFileLock } = await import(moduleUrl);

if (role === "holder") {
  await withPrivateFileLock(lockPath, async () => {
    writeFileSync(readyPath, "ready");
    const blockedUntil = Date.now() + 13_000;
    while (Date.now() < blockedUntil) {
      // Reproduce a native-module startup stall that delays lock refreshes.
    }
  });
} else {
  await withPrivateFileLock(lockPath, async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}
`;

function runChild(moduleUrl, lockPath, readyPath, role) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      CHILD_SCRIPT,
      moduleUrl,
      lockPath,
      readyPath,
      role,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    completed: new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    }),
  };
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

test(
  "does not steal a healthy Windows lock during a 13 second event-loop stall",
  { timeout: 60_000 },
  async () => {
    const testRoot = process.env.CLAWLORE_LOCK_TEST_ROOT
      ?? (process.platform === "win32" ? homedir() : tmpdir());
    const root = await mkdtemp(join(testRoot, ".clawlore-lock-stall-"));
    const lockPath = join(root, "memory-write.lock");
    const readyPath = join(root, "holder-ready");
    const moduleUrl =
      process.env.CLAWLORE_LOCK_MODULE_URL
      ?? pathToFileURL(
        join(import.meta.dirname, "..", "dist", "src", "private-file-lock.js"),
      ).href;
    let holder;
    let contender;

    try {
      const lockModule = await import(moduleUrl);
      assert.equal(lockModule.PRIVATE_FILE_LOCK_STALE_MS, 5 * 60 * 1000);
      assert.equal(lockModule.PRIVATE_FILE_LOCK_UPDATE_MS, 30_000);

      holder = runChild(moduleUrl, lockPath, readyPath, "holder");
      const holderStart = await Promise.race([
        waitForFile(readyPath, 20_000).then(() => ({ ready: true })),
        holder.completed.then((result) => ({ ready: false, result })),
      ]);
      assert.equal(
        holderStart.ready,
        true,
        `holder exited before acquiring the lock: ${
          holderStart.result?.stderr || holderStart.result?.stdout || "no output"
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10_500));
      contender = runChild(moduleUrl, lockPath, readyPath, "contender");

      const [holderResult, contenderResult] = await Promise.all([
        holder.completed,
        contender.completed,
      ]);
      assert.equal(
        holderResult.code,
        0,
        `holder failed: ${holderResult.stderr || holderResult.stdout}`,
      );
      assert.equal(
        contenderResult.code,
        0,
        `contender failed: ${contenderResult.stderr || contenderResult.stdout}`,
      );
    } finally {
      for (const running of [holder, contender]) {
        if (running?.child.exitCode === null) {
          running.child.kill();
          await running.completed;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
