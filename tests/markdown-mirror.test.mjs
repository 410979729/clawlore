import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createMdMirrorWriter } = jiti("../src/markdown-mirror.ts");

test("Markdown mirror appends sanitized content to a private regular file", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-markdown-mirror-"));
  const warnings = [];
  try {
    const api = {
      config: { agents: { list: [{ id: "main", workspace: root }] } },
      resolvePath: (value) => value,
      logger: { info() {}, warn(message) { warnings.push(message); } },
    };
    const writer = createMdMirrorWriter(api, { enabled: true }, join(root, "db", "truth.sqlite"), String);
    assert.ok(writer);
    const timestamp = Date.parse("2026-07-20T12:00:00.000Z");
    await writer({
      text: "Durable decision [Image attached at: /tmp/private-token-image.png]",
      category: "decision", scope: "agent:main", timestamp,
    }, { source: "manual", agentId: "main" });
    await writer({
      text: "Second durable decision", category: "decision", scope: "agent:main", timestamp,
    }, { source: "manual", agentId: "main" });

    const file = join(root, "memory", "2026-07-20.md");
    const output = await readFile(file, "utf8");
    assert.doesNotMatch(output, /private-token-image|\/tmp\//u);
    assert.match(output, /Second durable decision/u);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o077, 0);
    assert.equal(warnings.length, 0);

    if (process.platform !== "win32") {
      const target = join(root, "mirror-target.md");
      await writeFile(target, "unchanged\n", { mode: 0o600 });
      await rm(file);
      await mkdir(join(root, "memory"), { recursive: true });
      await symlink(target, file);
      await writer(
        { text: "Must not follow symlink", category: "fact", scope: "agent:main", timestamp },
        { agentId: "main" },
      );
      assert.equal(await readFile(target, "utf8"), "unchanged\n");
      assert.equal(warnings.length, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
