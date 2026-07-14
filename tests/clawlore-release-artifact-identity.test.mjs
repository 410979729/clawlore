import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareRuntimeArtifactIdentity,
  runtimeArtifactIdentity,
} from "../scripts/release-artifact-identity.mjs";

async function fixture(root, content = "runtime") {
  await mkdir(join(root, "dist", "src", "v2"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await writeFile(join(root, "openclaw.plugin.json"), JSON.stringify({ id: "fixture", version: "1.0.0" }));
  await writeFile(join(root, "dist", "index.js"), content);
  await writeFile(join(root, "dist", "src", "v2", "runtime.js"), "v2-runtime");
}

test("recursive runtime identity detects missing, extra, and changed artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-artifact-identity-"));
  const candidate = join(root, "candidate");
  const deployed = join(root, "deployed");
  try {
    await fixture(candidate);
    await fixture(deployed);
    const exact = compareRuntimeArtifactIdentity(
      await runtimeArtifactIdentity(candidate),
      await runtimeArtifactIdentity(deployed),
    );
    assert.equal(exact.matches, true);

    await writeFile(join(deployed, "dist", "index.js"), "changed");
    await writeFile(join(deployed, "dist", "extra.js"), "extra");
    await rm(join(deployed, "dist", "src", "v2", "runtime.js"));
    const drift = compareRuntimeArtifactIdentity(
      await runtimeArtifactIdentity(candidate),
      await runtimeArtifactIdentity(deployed),
    );
    assert.equal(drift.matches, false);
    assert.deepEqual(drift.different, ["dist/index.js"]);
    assert.deepEqual(drift.extra, ["dist/extra.js"]);
    assert.deepEqual(drift.missing, ["dist/src/v2/runtime.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime identity rejects symlinked artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-artifact-symlink-"));
  try {
    await fixture(root);
    await symlink(join(root, "dist", "index.js"), join(root, "dist", "linked.js"));
    await assert.rejects(runtimeArtifactIdentity(root), /contains symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
