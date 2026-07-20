import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { recordCompactionRun, shouldRunCompaction } = jiti("../src/memory-compactor.ts");

test("compaction cooldown state is a private atomic file", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-compactor-state-"));
  try {
    const file = join(root, "state", ".compaction-state.json");
    assert.equal(await shouldRunCompaction(file, 24), true);
    await recordCompactionRun(file);
    assert.equal((await lstat(file)).mode & 0o077, 0);
    assert.equal(await shouldRunCompaction(file, 24), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction cooldown state refuses symlink writes", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-compactor-symlink-"));
  try {
    const target = join(root, "target.json");
    const link = join(root, "state.json");
    await writeFile(target, '{"lastRunAt":0}', { mode: 0o600 });
    await symlink(target, link);
    assert.equal(await shouldRunCompaction(link, 24), true);
    await assert.rejects(() => recordCompactionRun(link), /SYMLINK/u);
    assert.equal(await readFile(target, "utf8"), '{"lastRunAt":0}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
