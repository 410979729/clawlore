import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

const { validateMemoryAddress } = jiti("../src/v2/domain/memory-address.ts");
const { resolveMemoryIdentity } = jiti("../src/v2/application/identity-resolver.ts");
const { decideMemoryAccess } = jiti("../src/v2/application/policy-decision.ts");
const { mapLegacyAddress } = jiti("../src/v2/migration/legacy-address-mapper.ts");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/clawlore-memory-address-v2.json", import.meta.url), "utf8"));

for (const item of fixture.identityCases) {
  test(`Identity Resolver V2: ${item.name}`, () => {
    const result = resolveMemoryIdentity(item.input);
    assert.equal(result.status, item.expected.status);
    if ("durableWriteAllowed" in item.expected) assert.equal(result.durableWriteAllowed, item.expected.durableWriteAllowed);
    if (item.expected.missing) assert.deepEqual(result.missing, item.expected.missing);
    if (result.address) {
      for (const field of ["principalId", "visibility", "conversationId", "threadId"]) {
        if (field in item.expected) assert.equal(result.address[field], item.expected[field]);
      }
      assert.equal(validateMemoryAddress(result.address).valid, true);
    }
  });
}

for (const item of fixture.legacyCases) {
  test(`Legacy address preview: ${item.name}`, () => {
    const result = mapLegacyAddress(item.input, { tenantId: "local", agentId: "main", workspaceId: "workspace-main" });
    assert.equal(result.principalResolution, item.expected.principalResolution);
    assert.equal(result.reviewRequired, item.expected.reviewRequired);
    assert.equal(result.verificationDebt, item.expected.verificationDebt);
    assert.equal(result.address.visibility, item.expected.visibility);
    if (item.expected.conversationId) assert.equal(result.address.conversationId, item.expected.conversationId);
  });
}

function address(overrides = {}) {
  return {
    schemaVersion: 2,
    tenantId: "local",
    principalId: "telegram:default:user-1",
    agentId: "main",
    platform: "telegram",
    accountId: "default",
    conversationId: "user-1",
    visibility: "private",
    retention: "working",
    ...overrides,
  };
}

test("private memory cannot cross principal", () => {
  const decision = decideMemoryAccess({
    actor: address(),
    target: address({ principalId: "telegram:default:user-2" }),
    operation: "recall",
    mode: "automatic",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "private_principal_mismatch");
});

test("conversation memory requires the same conversation and thread", () => {
  const decision = decideMemoryAccess({
    actor: address({ visibility: "conversation", conversationId: "group-9", threadId: "topic-3" }),
    target: address({ visibility: "conversation", conversationId: "group-9", threadId: "topic-4" }),
    operation: "recall",
    mode: "automatic",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "thread_mismatch");
});

test("global memory requires a grant and is never automatically injected by that grant", () => {
  const actor = address();
  const target = address({ visibility: "global" });
  const withoutGrant = decideMemoryAccess({ actor, target, operation: "recall", mode: "automatic" });
  assert.equal(withoutGrant.allowed, false);
  const withGrant = decideMemoryAccess({
    actor,
    target,
    operation: "recall",
    mode: "automatic",
    grants: [{
      id: "grant-global-read",
      effect: "allow",
      operations: ["recall"],
      subjectPrincipalId: actor.principalId,
      tenantId: actor.tenantId,
      agentId: actor.agentId,
      visibility: "global",
    }],
  });
  assert.equal(withGrant.allowed, true);
  assert.equal(withGrant.injectable, false);
  assert.equal(withGrant.reasonCode, "explicit_grant");
});
