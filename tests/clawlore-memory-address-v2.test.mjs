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

test("runtime address validation rejects forged enums, schema versions, and ambiguous identifiers", () => {
  assert.equal(validateMemoryAddress({ ...address(), schemaVersion: 1 }).valid, false);
  assert.equal(validateMemoryAddress({ ...address(), visibility: "shared-with-everyone" }).valid, false);
  assert.equal(validateMemoryAddress({ ...address(), retention: "forever" }).valid, false);
  assert.equal(validateMemoryAddress({ ...address(), principalId: " user-1" }).valid, false);
  assert.equal(validateMemoryAddress({ ...address(), conversationId: "group-1\nforged" }).valid, false);
  assert.equal(validateMemoryAddress(null).valid, false);
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

test("grants bind exact private, conversation, and project targets", () => {
  const actor = address();
  const privateTarget = address({ principalId: "telegram:default:user-2" });
  const broadPrivateGrant = {
    id: "grant-private-broad",
    effect: "allow",
    operations: ["recall"],
    subjectPrincipalId: actor.principalId,
    tenantId: actor.tenantId,
    agentId: actor.agentId,
    visibility: "private",
  };
  assert.equal(decideMemoryAccess({
    actor, target: privateTarget, operation: "recall", mode: "explicit", grants: [broadPrivateGrant],
  }).allowed, false);
  assert.equal(decideMemoryAccess({
    actor, target: privateTarget, operation: "recall", mode: "explicit",
    grants: [{ ...broadPrivateGrant, targetPrincipalId: privateTarget.principalId }],
  }).allowed, true);

  const conversationTarget = address({
    visibility: "conversation", principalId: "telegram:default:user-2",
    conversationId: "group-2", threadId: "topic-2",
  });
  const conversationGrant = {
    id: "grant-conversation",
    effect: "allow",
    operations: ["recall"],
    subjectPrincipalId: actor.principalId,
    tenantId: actor.tenantId,
    agentId: actor.agentId,
    visibility: "conversation",
    conversationId: "group-2",
  };
  assert.equal(decideMemoryAccess({
    actor, target: conversationTarget, operation: "recall", mode: "explicit", grants: [conversationGrant],
  }).allowed, false);
  assert.equal(decideMemoryAccess({
    actor, target: conversationTarget, operation: "recall", mode: "explicit",
    grants: [{ ...conversationGrant, threadId: "topic-2" }],
  }).allowed, true);

  const projectTarget = address({
    visibility: "project", principalId: "telegram:default:user-2", projectId: "project-2",
  });
  const projectGrant = {
    id: "grant-project",
    effect: "allow",
    operations: ["recall"],
    subjectPrincipalId: actor.principalId,
    tenantId: actor.tenantId,
    agentId: actor.agentId,
    visibility: "project",
  };
  assert.equal(decideMemoryAccess({
    actor, target: projectTarget, operation: "recall", mode: "explicit", grants: [projectGrant],
  }).allowed, false);
  assert.equal(decideMemoryAccess({
    actor, target: projectTarget, operation: "recall", mode: "explicit",
    grants: [{ ...projectGrant, projectId: "project-2" }],
  }).allowed, true);
});
