import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  findPreviousReflectionSessionFile,
  readSessionConversationWithResetFallback,
  summarizeRecentConversationMessages,
} = jiti("../src/reflection-transcript.ts");

test("reflection transcript keeps recent human turns and removes injected or private input", () => {
  const summary = summarizeRecentConversationMessages([
    { role: "system", content: "system prompt" },
    { role: "user", content: "/reset" },
    { role: "user", content: "<relevant-memories>hidden</relevant-memories>" },
    { role: "user", content: "contact joy@example.com with token=abcdef123456" },
    { role: "assistant", content: [{ type: "text", text: "done from /home/joy/private.txt" }] },
    { role: "tool", content: "ignored" },
  ], 2);

  assert.equal(
    summary,
    "user: contact [REDACTED] with [REDACTED]\nassistant: done from [REDACTED]",
  );
});

test("reflection transcript falls back to the newest usable reset snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-reflection-transcript-"));
  try {
    const active = join(root, "session.jsonl");
    const older = `${active}.reset.older`;
    const newer = `${active}.reset.newer`;
    await writeFile(active, "{partial", "utf8");
    await writeFile(
      older,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "older" } })}\n`,
      "utf8",
    );
    await writeFile(
      newer,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: "newer" } })}\n`,
      "utf8",
    );
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));

    assert.equal(
      await readSessionConversationWithResetFallback(active, 10),
      "assistant: newer",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reflection session recovery prefers reset base and canonical session identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-reflection-recovery-"));
  try {
    const base = join(root, "base.jsonl");
    const canonical = join(root, "session-id.jsonl");
    await writeFile(base, "", "utf8");
    await writeFile(canonical, "", "utf8");

    assert.equal(
      await findPreviousReflectionSessionFile(root, `${base}.reset.123`, "session-id"),
      base,
    );
    await rm(base);
    assert.equal(
      await findPreviousReflectionSessionFile(root, `${base}.reset.123`, "session-id"),
      canonical,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
