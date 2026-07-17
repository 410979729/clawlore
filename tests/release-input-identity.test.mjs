import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { committedGitBlobSha256, releaseInputIdentity } from "../scripts/release-input-identity.mjs";

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

test("release input identity uses committed Git blobs instead of platform working-tree bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-release-input-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "docs", "clawlore", "eval"), { recursive: true });
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "ClawLore Test"]);
    git(root, ["config", "user.email", "clawlore-test@example.invalid"]);
    git(root, ["config", "core.autocrlf", "false"]);
    await writeFile(join(root, "scripts", "input.mjs"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "package-lock.json"), "{\n  \"lockfileVersion\": 3\n}\n", "utf8");
    await writeFile(join(root, "TODO-clawlore.md"), "ledger\n", "utf8");
    await writeFile(join(root, "docs", "clawlore", "eval", "audit.md"), "audit\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "fixture"]);

    const canonical = releaseInputIdentity({ gitRoot: root, sourceRoot: root, diffPathspec: "." });
    assert.equal(canonical.algorithm, "sha256-git-blobs-release-inputs-v2");
    assert.equal(canonical.fileCount, 2);
    const canonicalLock = committedGitBlobSha256({ gitRoot: root, path: "package-lock.json" });
    assert.equal(
      canonicalLock,
      createHash("sha256").update("{\n  \"lockfileVersion\": 3\n}\n").digest("hex"),
    );

    await writeFile(join(root, "scripts", "input.mjs"), "export const value = 1;\r\n", "utf8");
    assert.notEqual(git(root, ["status", "--porcelain"]), "");
    const crlfWorkingTree = releaseInputIdentity({ gitRoot: root, sourceRoot: root, diffPathspec: "." });
    assert.deepEqual(crlfWorkingTree, canonical);

    await writeFile(join(root, "package-lock.json"), "{\r\n  \"lockfileVersion\": 3\r\n}\r\n", "utf8");
    assert.notEqual(
      createHash("sha256").update(await readFile(join(root, "package-lock.json"))).digest("hex"),
      canonicalLock,
    );
    assert.equal(committedGitBlobSha256({ gitRoot: root, path: "package-lock.json" }), canonicalLock);

    await writeFile(join(root, "scripts", "input.mjs"), "export const value = 2;\n", "utf8");
    git(root, ["add", "scripts/input.mjs"]);
    git(root, ["commit", "--quiet", "-m", "change input"]);
    const changedCommit = releaseInputIdentity({ gitRoot: root, sourceRoot: root, diffPathspec: "." });
    assert.notEqual(changedCommit.digest, canonical.digest);
    assert.equal(changedCommit.fileCount, canonical.fileCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
