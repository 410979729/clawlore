import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  buildCompatMemoryPromptSection,
  createCompatMemorySearchManager,
  scoreMarkdownMatch,
} = jiti("../src/markdown-compat.ts");

test("Markdown compatibility scoring preserves exact and term matches", () => {
  const exact = scoreMarkdownMatch("release decision", "The release decision remains NO-GO.");
  const terms = scoreMarkdownMatch("decision release", "The release decision remains NO-GO.");
  assert.ok(exact.score > terms.score);
  assert.equal(scoreMarkdownMatch("missing", "unrelated").index, -1);
});

test("Markdown compatibility manager searches memory and rejects traversal", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "clawlore-markdown-compat-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  await mkdir(join(workspaceDir, "memory", "nested"), { recursive: true });
  await writeFile(
    join(workspaceDir, "memory", "nested", "decision.md"),
    "# Decision\nThe exact release decision remains NO-GO until audit.\n",
    "utf8",
  );
  await writeFile(join(workspaceDir, "outside.md"), "must not be readable", "utf8");

  const manager = createCompatMemorySearchManager({
    workspaceDir,
    provider: "clawlore",
    model: "test-model",
    dbPath: "/test/memory.sqlite3",
    pluginVersion: "test",
  });
  const results = await manager.search("release decision", { maxResults: 3 });
  assert.equal(results.length, 1);
  assert.equal(results[0].path, "memory/nested/decision.md");
  assert.match(results[0].snippet, /NO-GO until audit/);
  assert.match((await manager.readFile({ relPath: results[0].path, from: 2, lines: 1 })).text, /release decision/);
  await assert.rejects(() => manager.readFile({ relPath: "../outside.md" }), /invalid Markdown relPath/);
  await assert.rejects(() => manager.readFile({ relPath: workspaceDir }), /invalid Markdown relPath/);
});

test("Markdown compatibility prompt exposes only available host tools", () => {
  assert.deepEqual(buildCompatMemoryPromptSection({ availableTools: new Set() }), []);
  const both = buildCompatMemoryPromptSection({
    availableTools: new Set(["memory_search", "memory_get"]),
    citationsMode: "off",
  });
  assert.match(both.join("\n"), /memory_search first/);
  assert.match(both.join("\n"), /Citations are disabled/);
});
