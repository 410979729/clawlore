import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHILD_MODE = process.env.CLAWLORE_MEMORY_LOCK_CHILD === "1";

async function runLockChild() {
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const { withMemoryWriteLock } = jiti("../src/memory-write-lock.ts");
  const dbPath = process.env.CLAWLORE_MEMORY_LOCK_DB_PATH;
  const logPath = process.env.CLAWLORE_MEMORY_LOCK_LOG_PATH;
  const childId = process.env.CLAWLORE_MEMORY_LOCK_CHILD_ID;
  if (!dbPath || !logPath || !childId) throw new Error("memory lock child fixture is incomplete");

  await withMemoryWriteLock(dbPath, async () => {
    await appendFile(logPath, `enter:${childId}\n`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await appendFile(logPath, `exit:${childId}\n`, "utf8");
  });
}

function spawnLockChild(dbPath, logPath, childId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        CLAWLORE_MEMORY_LOCK_CHILD: "1",
        CLAWLORE_MEMORY_LOCK_DB_PATH: dbPath,
        CLAWLORE_MEMORY_LOCK_LOG_PATH: logPath,
        CLAWLORE_MEMORY_LOCK_CHILD_ID: childId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`memory lock child failed: code=${code} signal=${signal} ${stderr}`));
    });
  });
}

if (CHILD_MODE) {
  await runLockChild();
} else {
  test("memory write lock serializes independent processes and keeps the lock file private", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawlore-memory-write-lock-"));
    const dbPath = join(root, "vector");
    const logPath = join(root, "critical-sections.log");
    await mkdir(dbPath, { mode: 0o700 });
    try {
      await Promise.all([
        spawnLockChild(dbPath, logPath, "a"),
        spawnLockChild(dbPath, logPath, "b"),
      ]);

      const lines = (await readFile(logPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 4);
      const firstId = lines[0].split(":")[1];
      const secondId = lines[2].split(":")[1];
      assert.match(lines[0], /^enter:[ab]$/);
      assert.equal(lines[1], `exit:${firstId}`);
      assert.match(lines[2], /^enter:[ab]$/);
      assert.equal(lines[3], `exit:${secondId}`);
      assert.notEqual(firstId, secondId);

      const lockInfo = await stat(join(dbPath, ".memory-write.lock"));
      assert.equal(lockInfo.mode & 0o777, 0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
