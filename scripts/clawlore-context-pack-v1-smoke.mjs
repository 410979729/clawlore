import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { runCompatibilityContextShadow } = jiti("../src/v2/adapters/openclaw/compatibility-context-adapter.ts");

let retrievalCalls = 0;
const runtime = {
  platform: "telegram",
  accountId: "default",
  chatType: "direct",
  conversationId: "user-smoke",
  senderId: "user-smoke",
};

const result = await runCompatibilityContextShadow({
  traceId: "context-pack-v1-smoke",
  availableTokens: 64,
  queryText: "concise answer preference",
  identity: { tenantId: "local", agentId: "main", runtimeContext: runtime },
  retrieveCandidates: async ({ boundary }) => {
    retrievalCalls += 1;
    return [{
      id: "memory-smoke-1",
      section: "profile",
      text: "The user prefers concise answers.",
      targetAddress: {
        schemaVersion: 2,
        tenantId: boundary.tenantId,
        principalId: boundary.principalId,
        agentId: boundary.agentId,
        platform: boundary.platform,
        accountId: boundary.accountId,
        conversationId: boundary.conversationId,
        visibility: boundary.visibility,
        retention: "working",
      },
      score: 0.9,
      confidence: 0.95,
      estimatedTokens: 8,
      lifecycle: "active",
      verification: "user_confirmed",
      freshness: "current",
      citation: { sourceType: "user_message", sourceId: "smoke-source" },
    }];
  },
});

const stages = result.trace.map((item) => item.stage);
const pass = result.mode === "shadow"
  && result.identity.status === "resolved"
  && result.preflight?.injectable === true
  && result.retrievalInvoked === true
  && retrievalCalls === 1
  && result.pack?.trace.selectedCount === 1
  && result.hookResult === undefined
  && stages.join(",") === "identity,policy_preflight,candidate_retrieval,compose";

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  status: pass ? "PASS" : "FAIL",
  mode: result.mode,
  identityStatus: result.identity.status,
  policyInjectable: result.preflight?.injectable ?? false,
  retrievalCalls,
  selectedCount: result.pack?.trace.selectedCount ?? 0,
  hookMutationProduced: result.hookResult !== undefined,
  stages,
}, null, 2)}\n`);

if (!pass) process.exitCode = 1;
