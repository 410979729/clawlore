import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryStore } = jiti("../src/store.ts");
const { withMemoryWriteLock } = jiti("../src/memory-write-lock.ts");

test("MemoryStore refuses a symlinked interprocess write lock", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-store-lock-"));
  const target = join(root, "outside-target");
  const lock = join(root, ".memory-write.lock");
  let store;
  try {
    writeFileSync(target, "unchanged\n", { mode: 0o600 });
    symlinkSync(target, lock);
    store = new MemoryStore({ dbPath: root, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
    await assert.rejects(() => store.store({
      text: "Verified lock boundary evidence",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "agent:test",
      importance: 0.8,
      metadata: JSON.stringify({ state: "confirmed" }),
    }), /SYMLINK/u);
    assert.equal(readFileSync(target, "utf8"), "unchanged\n");
  } finally {
    await store?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("MemoryStore initialization waits for the canonical write lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-store-init-lock-"));
  let releaseLock;
  let signalLocked;
  const locked = new Promise((resolve) => {
    signalLocked = resolve;
  });
  const hold = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const lockTask = withMemoryWriteLock(root, async () => {
    signalLocked();
    await hold;
  });
  let store;
  try {
    await locked;
    store = new MemoryStore({
      dbPath: root,
      vectorDim: 4,
      vectorBackend: "sqlite-bruteforce",
    });
    let settled = false;
    const statsTask = store.stats().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false);
    assert.equal(existsSync(join(root, "memory.sqlite3")), false);

    releaseLock();
    await lockTask;
    const stats = await statsTask;
    assert.equal(stats.totalCount, 0);
    assert.equal(existsSync(join(root, "memory.sqlite3")), true);
  } finally {
    releaseLock?.();
    await lockTask.catch(() => undefined);
    await store?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("MemoryStore FTS rebuild waits for the canonical write lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-store-fts-lock-"));
  let releaseLock;
  let signalLocked;
  const locked = new Promise((resolve) => {
    signalLocked = resolve;
  });
  const hold = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const lockTask = withMemoryWriteLock(root, async () => {
    signalLocked();
    await hold;
  });
  const store = new MemoryStore({
    dbPath: root,
    vectorDim: 4,
    vectorBackend: "lancedb",
  });
  let indexReads = 0;
  const runtime = store.ports;
  runtime.initialized = true;
  runtime.table = {
    async listIndices() {
      indexReads += 1;
      return [{ name: "text", indexType: "FTS", columns: ["text"] }];
    },
    async dropIndex() {},
    async close() {},
  };
  try {
    await locked;
    let settled = false;
    const rebuildTask = store.rebuildFtsIndex().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false);
    assert.equal(indexReads, 0);

    releaseLock();
    await lockTask;
    assert.deepEqual(await rebuildTask, { success: true });
    assert.equal(indexReads, 2);
  } finally {
    releaseLock?.();
    await lockTask.catch(() => undefined);
    await store.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
