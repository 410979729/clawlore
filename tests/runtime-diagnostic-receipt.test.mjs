import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { artifactBinding, releaseProvenance } from "./fixtures/release-provenance.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { buildReleaseReadinessReceipt } = jiti("../src/v2/application/release-readiness.ts");
const {
  assessRuntimeDiagnostic,
  buildRuntimeDiagnosticReceipt,
  createRuntimeInstanceIdentity,
  invalidateRuntimeDiagnosticReceipt,
  renewRuntimeDiagnosticReceipt,
  writeRuntimeDiagnosticReceipt,
} = jiti("../src/runtime-diagnostic-receipt.ts");
const { createRuntimeDiagnosticLeaseController } = jiti("../src/runtime-shadow-registration.ts");

const configDigest = artifactBinding().configDigest;

function readiness(expiresAt = "2026-07-21T00:00:00.000Z") {
  const provenance = { ...releaseProvenance(), expiresAt };
  return buildReleaseReadinessReceipt({
    rolloutId: "runtime-diagnostic-fixture",
    requestedMode: "shadow",
    currentMode: "shadow",
    evidence: {
      focusedTests: true, fullTests: true, typecheck: true, build: true,
      moduleBoundaries: true, releaseGate: true, snapshotVerified: false,
      migrationDrill: false, rollbackDrill: false, legacyHashUnchanged: false,
      forbiddenScopeViolations: 0,
    },
    provenance,
    now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
}

function registeredRuntime() {
  return {
    status: "registered",
    requestedMode: "shadow",
    registeredHooks: ["message_received"],
    writeEnabled: false,
    promptMutationEnabled: false,
    contextEngineRegistered: false,
    blockingReasons: [],
  };
}

test("matching shadow runtime receipt proves one read-only registered hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-runtime-diagnostic-"));
  try {
    const file = join(root, "runtime.json");
    const receipt = buildRuntimeDiagnosticReceipt({
      configDigest,
      binding: artifactBinding(),
      readiness: readiness(),
      readinessErrors: [],
      runtime: registeredRuntime(),
      now: () => new Date("2026-07-19T00:01:00.000Z"),
    });
    await writeRuntimeDiagnosticReceipt(file, receipt);
    const report = await assessRuntimeDiagnostic({
      file,
      configuredMode: "shadow",
      configDigest,
      now: () => new Date("2026-07-19T00:01:20.000Z"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "registered");
    assert.deepEqual(report.receipt.runtime.registeredHooks, ["message_received"]);
    assert.equal(report.receipt.runtime.writeEnabled, false);
    assert.equal(report.receipt.runtime.promptMutationEnabled, false);
    assert.deepEqual(report.receipt.runtime.blockingReasons, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired or config-mismatched shadow receipts fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-runtime-diagnostic-"));
  try {
    const file = join(root, "runtime.json");
    await writeRuntimeDiagnosticReceipt(file, buildRuntimeDiagnosticReceipt({
      configDigest,
      binding: artifactBinding(),
      readiness: readiness("2026-07-19T00:01:30.000Z"),
      readinessErrors: [],
      runtime: registeredRuntime(),
      now: () => new Date("2026-07-19T00:01:00.000Z"),
    }));
    const report = await assessRuntimeDiagnostic({
      file,
      configuredMode: "shadow",
      configDigest: "f".repeat(64),
      now: () => new Date("2026-07-19T00:02:00.000Z"),
    });

    assert.equal(report.ok, false);
    assert.ok(report.issues.includes("runtime_diagnostic_config_digest_mismatch"));
    assert.ok(report.issues.includes("runtime_diagnostic_readiness_expired"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dead, reused, or unverifiable Gateway process identities fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-runtime-diagnostic-"));
  try {
    const file = join(root, "runtime.json");
    const receipt = buildRuntimeDiagnosticReceipt({
      configDigest,
      binding: artifactBinding(),
      readiness: readiness(),
      readinessErrors: [],
      runtime: registeredRuntime(),
      instance: {
        instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        processId: 2_147_483_646,
        processStartToken: "linux:test-boot:123",
      },
      now: () => new Date("2026-07-19T00:01:00.000Z"),
    });
    await writeRuntimeDiagnosticReceipt(file, receipt);

    const actualDead = await assessRuntimeDiagnostic({
      file,
      configuredMode: "shadow",
      configDigest,
      now: () => new Date("2026-07-19T00:01:05.000Z"),
    });
    assert.equal(actualDead.ok, false);
    assert.ok(actualDead.issues.includes("runtime_diagnostic_process_dead"));

    for (const [processStatus, issue] of [
      ["dead", "runtime_diagnostic_process_dead"],
      ["mismatch", "runtime_diagnostic_process_identity_mismatch"],
      ["unavailable", "runtime_diagnostic_process_identity_unavailable"],
    ]) {
      const report = await assessRuntimeDiagnostic({
        file,
        configuredMode: "shadow",
        configDigest,
        now: () => new Date("2026-07-19T00:01:05.000Z"),
        processIdentityProbe: () => processStatus,
      });
      assert.equal(report.ok, false, processStatus);
      assert.ok(report.issues.includes(issue), processStatus);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime heartbeat is a short renewable lease and stop invalidates it immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-runtime-diagnostic-"));
  try {
    const file = join(root, "runtime.json");
    const instance = createRuntimeInstanceIdentity();
    const initial = buildRuntimeDiagnosticReceipt({
      configDigest,
      binding: artifactBinding(),
      readiness: readiness(),
      readinessErrors: [],
      runtime: registeredRuntime(),
      instance,
      now: () => new Date("2026-07-19T00:01:00.000Z"),
    });
    await writeRuntimeDiagnosticReceipt(file, initial);
    const expired = await assessRuntimeDiagnostic({
      file,
      configuredMode: "shadow",
      configDigest,
      now: () => new Date("2026-07-19T00:01:31.000Z"),
      processIdentityProbe: () => "match",
    });
    assert.equal(expired.ok, false);
    assert.ok(expired.issues.includes("runtime_diagnostic_lease_expired"));

    const renewed = renewRuntimeDiagnosticReceipt(initial, () => new Date("2026-07-19T00:01:20.000Z"));
    await writeRuntimeDiagnosticReceipt(file, renewed);
    const live = await assessRuntimeDiagnostic({
      file,
      configuredMode: "shadow",
      configDigest,
      now: () => new Date("2026-07-19T00:01:31.000Z"),
      processIdentityProbe: () => "match",
    });
    assert.equal(live.ok, true);
    assert.equal(live.receipt.instance.instanceId, instance.instanceId);

    await writeRuntimeDiagnosticReceipt(
      file,
      invalidateRuntimeDiagnosticReceipt(renewed, "runtime_diagnostic_stopped", () => new Date("2026-07-19T00:01:32.000Z")),
    );
    const stopped = await assessRuntimeDiagnostic({
      file,
      configuredMode: "shadow",
      configDigest,
      now: () => new Date("2026-07-19T00:01:32.000Z"),
      processIdentityProbe: () => "match",
    });
    assert.equal(stopped.ok, false);
    assert.ok(stopped.issues.includes("runtime_diagnostic_stopped"));
    assert.ok(stopped.issues.includes("runtime_diagnostic_lease_expired"));
    assert.ok(stopped.issues.includes("runtime_diagnostic_not_registered"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one runtime service object can recover through start stop start", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-runtime-restart-"));
  const file = join(root, "runtime.json");
  const warnings = [];
  const baseReceipt = buildRuntimeDiagnosticReceipt({
    configDigest,
    binding: artifactBinding(),
    readiness: readiness(),
    readinessErrors: [],
    runtime: registeredRuntime(),
  });
  const controller = createRuntimeDiagnosticLeaseController({
    file,
    baseReceipt,
    logger: { warn(message) { warnings.push(message); } },
  });
  try {
    await controller.start();
    await controller.stop();
    await controller.start();
    const restarted = await assessRuntimeDiagnostic({
      file,
      configuredMode: "shadow",
      configDigest,
      processIdentityProbe: () => "match",
    });
    assert.equal(restarted.ok, true);
    assert.equal(restarted.status, "registered");
    assert.deepEqual(restarted.receipt.runtime.registeredHooks, ["message_received"]);
    assert.deepEqual(restarted.receipt.runtime.blockingReasons, []);
    assert.deepEqual(warnings, []);
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled mode is healthy without a runtime receipt", async () => {
  const report = await assessRuntimeDiagnostic({
    configuredMode: "disabled",
    configDigest,
  });
  assert.deepEqual(report, {
    schemaVersion: 2,
    ok: true,
    status: "disabled",
    configuredMode: "disabled",
    receiptPresent: false,
    issues: [],
  });
});

test("disabled mode ignores an expired stopped lease but rejects a shadow receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-runtime-diagnostic-"));
  try {
    const file = join(root, "runtime.json");
    const disabled = buildRuntimeDiagnosticReceipt({
      configDigest,
      readinessErrors: [],
      runtime: {
        status: "disabled",
        requestedMode: "disabled",
        registeredHooks: [],
        writeEnabled: false,
        promptMutationEnabled: false,
        contextEngineRegistered: false,
        blockingReasons: [],
      },
      now: () => new Date("2026-07-19T00:01:00.000Z"),
    });
    await writeRuntimeDiagnosticReceipt(
      file,
      invalidateRuntimeDiagnosticReceipt(disabled, "runtime_diagnostic_stopped", () => new Date("2026-07-19T00:01:01.000Z")),
    );
    const healthy = await assessRuntimeDiagnostic({
      file,
      configuredMode: "disabled",
      configDigest: "f".repeat(64),
      now: () => new Date("2026-07-19T00:10:00.000Z"),
      processIdentityProbe: () => "dead",
    });
    assert.equal(healthy.ok, true);
    assert.equal(healthy.status, "disabled");

    await writeRuntimeDiagnosticReceipt(file, buildRuntimeDiagnosticReceipt({
      configDigest,
      binding: artifactBinding(),
      readiness: readiness(),
      readinessErrors: [],
      runtime: registeredRuntime(),
      now: () => new Date("2026-07-19T00:01:00.000Z"),
    }));
    const mismatched = await assessRuntimeDiagnostic({
      file,
      configuredMode: "disabled",
      configDigest,
      now: () => new Date("2026-07-19T00:01:01.000Z"),
    });
    assert.equal(mismatched.ok, false);
    assert.ok(mismatched.issues.includes("runtime_diagnostic_mode_mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
