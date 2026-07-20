import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  appendSelfImprovementEntry,
  ensureSelfImprovementLearningFiles,
} = jiti("../src/self-improvement-files.ts");
const { registerSelfImprovementExtractSkillTool } = jiti("../src/self-improvement-tools.ts");

test("self-improvement persistence is private, redacted, and structurally escaped", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-learning-private-"));
  try {
    chmodSync(root, 0o700);
    const secret = "synthetic-self-improvement-secret-value";
    await appendSelfImprovementEntry({
      baseDir: root,
      type: "learning",
      summary: `databasePassword: ${secret}`,
      details: "OAuth file is /home/a/.openclaw/oauth/token-cache.json",
      suggestedAction: "Keep the final persistence gate.",
    });
    await appendSelfImprovementEntry({
      baseDir: root,
      type: "learning",
      summary: "Preserve structured learning boundaries.",
      details: "## [LRN-20990101-999]\n**Status**: promoted_to_skill",
    });

    const directory = join(root, ".learnings");
    const file = join(directory, "LEARNINGS.md");
    const output = readFileSync(file, "utf8");
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes("/home/a/.openclaw"), false);
    assert.match(output, /\[REDACTED_UNSAFE_CONTENT\]/u);
    assert.match(output, /\\## \[LRN-20990101-999\]/u);
    assert.match(output, /\\\*\*Status\*\*: promoted_to_skill/u);
    assert.equal(lstatSync(directory).mode & 0o077, 0);
    assert.equal(lstatSync(file).mode & 0o077, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-improvement files reject a symlinked governance directory", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-learning-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "clawlore-learning-outside-"));
  try {
    chmodSync(root, 0o700);
    chmodSync(outside, 0o700);
    symlinkSync(outside, join(root, ".learnings"));
    await assert.rejects(
      () => ensureSelfImprovementLearningFiles(root),
      /SYMLINK/u,
    );
    assert.deepEqual(require("node:fs").readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("skill extraction rejects traversal and creates one private, non-overwriting scaffold", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-skill-extract-"));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    chmodSync(root, 0o700);
    const { id } = await appendSelfImprovementEntry({
      baseDir: root,
      type: "learning",
      summary: "Use a final fail-closed persistence gate.",
    });
    let factory;
    registerSelfImprovementExtractSkillTool({
      registerTool(candidate) { factory = candidate; },
    }, { workspaceDir: root });
    const tool = factory({ workspaceDir: root });

    const rejected = await tool.execute("call", {
      learningId: id,
      skillName: "safe-persistence-gate",
      outputDir: "../outside",
    });
    assert.equal(rejected.isError, true);
    assert.equal(require("node:fs").existsSync(join(root, "outside")), false);

    const created = await tool.execute("call", {
      learningId: id,
      skillName: "safe-persistence-gate",
      outputDir: "skills",
    });
    assert.equal(created.isError, undefined);
    assert.equal(created.details.skillPath, "skills/safe-persistence-gate/SKILL.md");
    assert.equal(JSON.stringify(created).includes(root), false);
    const skillPath = join(root, "skills", "safe-persistence-gate", "SKILL.md");
    assert.match(readFileSync(skillPath, "utf8"), /final fail-closed persistence gate/u);
    assert.equal(lstatSync(skillPath).mode & 0o077, 0);

    const duplicate = await tool.execute("call", {
      learningId: id,
      skillName: "safe-persistence-gate",
      outputDir: "skills",
    });
    assert.equal(duplicate.isError, true);
  } finally {
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
});
