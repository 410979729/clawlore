import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { artifactBinding, releaseProvenance } from "./fixtures/release-provenance.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { buildReleaseReadinessReceipt } = jiti("../src/v2/application/release-readiness.ts");
const { loadRuntimeRolloutControlsV1 } = jiti("../src/v2/adapters/openclaw/runtime-rollout-control.ts");
const { createLegacyShadowCandidateRetrieverV1 } = jiti("../src/v2/adapters/openclaw/legacy-shadow-retrieval.ts");
const { verifyPrivatePath } = jiti("../src/file-privacy.ts");

function readiness() {
  const provenance = releaseProvenance();
  return buildReleaseReadinessReceipt({
    rolloutId: "live-shadow-fixture",
    requestedMode: "shadow",
    currentMode: "disabled",
    evidence: {
      focusedTests: true,
      fullTests: true,
      typecheck: true,
      build: true,
      moduleBoundaries: true,
      releaseGate: true,
      snapshotVerified: false,
      migrationDrill: false,
      rollbackDrill: false,
      legacyHashUnchanged: false,
      forbiddenScopeViolations: 0,
    },
    provenance,
    now: () => new Date("2026-07-12T04:00:00.000Z"),
  });
}

test("rollout controls require one private readiness file", async () => {
  const privateFixtureParent = process.platform === "win32" ? homedir() : tmpdir();
  const root = await mkdtemp(join(privateFixtureParent, "clawlore-rollout-control-"));
  try {
    const readinessFile = join(root, "readiness.json");
    await writeFile(readinessFile, `${JSON.stringify(readiness())}\n`, { mode: 0o600 });

    const loaded = loadRuntimeRolloutControlsV1({ readinessFile, expectedBinding: artifactBinding() });
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.readiness?.status, "ready");
    verifyPrivatePath(readinessFile, { kind: "file" });

    const invalidDurableShadow = loadRuntimeRolloutControlsV1({
      readinessFile,
      expectedBinding: artifactBinding(),
      verification: "durable-release",
    });
    assert.deepEqual(invalidDurableShadow.errors, ["release_readiness_durable_mode_invalid"]);
    assert.equal(invalidDurableShadow.readiness, undefined);

    const mismatched = loadRuntimeRolloutControlsV1({
      readinessFile,
      expectedBinding: { ...artifactBinding(), runtimeDigest: "f".repeat(64) },
    });
    assert.deepEqual(mismatched.errors, ["release_readiness_provenance_mismatch:runtimeDigest"]);
    assert.equal(mismatched.readiness, undefined);

    if (process.platform === "win32") {
      await chmod(readinessFile, 0o644);
      const stillPrivate = loadRuntimeRolloutControlsV1({ readinessFile, expectedBinding: artifactBinding() });
      assert.deepEqual(stillPrivate.errors, []);
      assert.equal(stillPrivate.readiness?.status, "ready");
      verifyPrivatePath(readinessFile, { kind: "file" });
    } else {
      await chmod(readinessFile, 0o644);
      const unsafe = loadRuntimeRolloutControlsV1({ readinessFile, expectedBinding: artifactBinding() });
      assert.deepEqual(unsafe.errors, ["rollout_control_permissions_must_be_0600"]);
      assert.equal(unsafe.readiness, undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy shadow retrieval is local-read-only and preserves identity debt", async () => {
  const calls = [];
  const retrieve = createLegacyShadowCandidateRetrieverV1({
    workspaceId: "workspace-fixture",
    candidateLimit: 4,
    resolveScopeFilter(agentId) {
      assert.equal(agentId, "main");
      return ["agent:main"];
    },
    async retrieve(input) {
      calls.push(input);
      return [{
        entry: {
          id: "legacy-1",
          text: "legacy candidate",
          category: "fact",
          scope: "agent:main",
          metadata: JSON.stringify({ state: "confirmed", source: "auto_capture" }),
        },
        score: 0.9,
      }];
    },
  });

  const candidates = await retrieve({
    queryText: "legacy candidate query",
    boundary: {
      tenantId: "local",
      principalId: "telegram:default:user-1",
      agentId: "main",
      workspaceId: "workspace-fixture",
      platform: "telegram",
      accountId: "default",
      conversationId: "user-1",
      visibility: "private",
    },
  });
  assert.deepEqual(calls, [{
    query: "legacy candidate query",
    limit: 4,
    scopeFilter: ["agent:main"],
    source: "auto-recall",
  }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].targetAddress.principalId, "legacy:unresolved");
  assert.equal(candidates[0].verification, "unverified");
});
