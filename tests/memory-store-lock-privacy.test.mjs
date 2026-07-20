import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryStore } = jiti("../src/store.ts");

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
