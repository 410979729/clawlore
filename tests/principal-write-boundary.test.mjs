import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  CLAWLORE_PRINCIPAL_SCOPE_CONTRACT,
  resolvePrincipalWriteTarget,
} = jiti("../src/principal-write-boundary.ts");

const joyPrincipal = "telegram:default:8176453077";
const joySession = "agent:main:telegram:default:direct:8176453077";

function expectedScope(principal) {
  return `user:${createHash("sha256").update(principal).digest("hex").slice(0, 32)}`;
}

test("principal and runtime session entry points resolve the same versioned private scope", () => {
  const direct = resolvePrincipalWriteTarget({ principalKey: joyPrincipal });
  const runtime = resolvePrincipalWriteTarget({ sessionKey: joySession });
  assert.equal(direct.contract, CLAWLORE_PRINCIPAL_SCOPE_CONTRACT);
  assert.equal(direct.contract, "openclaw-scope-v1");
  assert.equal(direct.scope, expectedScope(joyPrincipal));
  assert.deepEqual(runtime, direct);
});

test("resolution is deterministic across repeated process-style restarts", () => {
  const snapshots = Array.from({ length: 8 }, () =>
    resolvePrincipalWriteTarget({ sessionKey: joySession }));
  assert.equal(new Set(snapshots.map((item) => JSON.stringify(item))).size, 1);
});

test("different private users never share a write scope", () => {
  const joy = resolvePrincipalWriteTarget({ sessionKey: joySession });
  const other = resolvePrincipalWriteTarget({
    sessionKey: "agent:main:telegram:default:direct:999",
  });
  assert.notEqual(joy.scope, other.scope);
  assert.notEqual(joy.principalHash, other.principalHash);
});

test("missing, ambiguous, malformed, group, cron, and explicit sessions fail closed", () => {
  const cases = [
    {},
    { principalKey: joyPrincipal, sessionKey: joySession },
    { principalKey: "telegram:*:8176453077" },
    { sessionKey: "agent:main:telegram:default:group:-1003772062784" },
    { sessionKey: "agent:main:cron:job-id" },
    { sessionKey: "agent:main:explicit:operator-smoke" },
  ];
  for (const input of cases) {
    assert.throws(() => resolvePrincipalWriteTarget(input), /CLAWLORE_WRITE_IDENTITY_/);
  }
});

test("conversation writes require an explicit policy and remain disjoint from private scope", () => {
  const conversation = resolvePrincipalWriteTarget({
    sessionKey: "agent:main:telegram:default:group:-1003772062784",
    allowConversation: true,
  });
  const privateTarget = resolvePrincipalWriteTarget({ sessionKey: joySession });
  assert.equal(conversation.kind, "conversation");
  assert.match(conversation.scope, /^custom:channel:/u);
  assert.notEqual(conversation.scope, privateTarget.scope);
});
