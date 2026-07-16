import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { verifyPrivatePath } = jiti("../src/file-privacy.ts");
const {
  JsonlRuntimeShadowTraceSink,
  normalizeRuntimeShadowConfig,
  runDefaultOffRuntimeShadow,
} = jiti("../src/v2/adapters/openclaw/runtime-shadow.ts");

const identity = {
  tenantId: "local",
  agentId: "main",
  runtimeContext: {
    senderId: "user-secret-id",
    platform: "telegram",
    accountId: "default",
    chatType: "direct",
    conversationId: "user-secret-id",
  },
};

test("runtime shadow is default-off and never calls retrieval", async () => {
  let calls = 0;
  const receipt = await runDefaultOffRuntimeShadow({
    config: normalizeRuntimeShadowConfig(undefined),
    input: {
      traceId: "shadow-disabled",
      availableTokens: 32,
      queryText: "disabled query",
      identity,
      retrieveCandidates: async () => { calls += 1; return []; },
    },
  });
  assert.equal(receipt.status, "disabled");
  assert.equal(calls, 0);
});

test("runtime shadow trace excludes raw principal and memory text", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-shadow-"));
  try {
    const traceFile = join(root, "trace.jsonl");
    const receipt = await runDefaultOffRuntimeShadow({
      config: { enabled: true },
      sink: new JsonlRuntimeShadowTraceSink(traceFile, 16_384),
      now: () => new Date("2026-07-11T09:00:00.000Z"),
      input: {
        traceId: "shadow-enabled",
        availableTokens: 32,
        queryText: "private preference",
        identity,
        retrieveCandidates: async ({ boundary }) => [{
          id: "memory-1",
          section: "profile",
          text: "private raw memory text",
          targetAddress: {
            schemaVersion: 2,
            tenantId: boundary.tenantId,
            principalId: boundary.principalId,
            agentId: boundary.agentId,
            platform: boundary.platform,
            accountId: boundary.accountId,
            conversationId: boundary.conversationId,
            visibility: "private",
            retention: "durable",
          },
          lifecycle: "active",
          verification: "user_confirmed",
          freshness: "current",
          score: 1,
          confidence: 1,
        }],
      },
    });
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.selectedCount, 1);
    const serialized = await readFile(traceFile, "utf8");
    assert.doesNotMatch(serialized, /user-secret-id/);
    assert.doesNotMatch(serialized, /private raw memory text/);
    verifyPrivatePath(traceFile, { kind: "file" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
