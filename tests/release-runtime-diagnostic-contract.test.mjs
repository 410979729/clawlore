import assert from "node:assert/strict";
import test from "node:test";

import { assertRuntimeDiagnostic } from "../scripts/runtime-diagnostic-contract.mjs";

function report(mode, configuredMode = mode) {
  const contracts = {
    disabled: {
      status: "disabled",
      registeredHooks: [],
      writeEnabled: false,
      promptMutationEnabled: false,
      contextEngineRegistered: false,
    },
    shadow: {
      status: "registered",
      registeredHooks: ["message_received"],
      writeEnabled: false,
      promptMutationEnabled: false,
      contextEngineRegistered: false,
    },
    "v2-write": {
      status: "registered",
      registeredHooks: [],
      writeEnabled: true,
      promptMutationEnabled: false,
      contextEngineRegistered: false,
    },
    cutover: {
      status: "registered",
      registeredHooks: [],
      writeEnabled: true,
      promptMutationEnabled: true,
      contextEngineRegistered: true,
    },
  };
  const contract = contracts[mode];
  return {
    runtimeDiagnostic: {
      ok: true,
      status: contract.status,
      configuredMode,
      receipt: {
        runtime: {
          status: contract.status,
          requestedMode: mode,
          registeredHooks: contract.registeredHooks,
          registeredHookCount: contract.registeredHooks.length,
          writeEnabled: contract.writeEnabled,
          promptMutationEnabled: contract.promptMutationEnabled,
          contextEngineRegistered: contract.contextEngineRegistered,
          blockingReasons: [],
        },
        readiness: mode === "disabled"
          ? { status: "not_required", bindingVerified: false, errors: [] }
          : { status: "ready", bindingVerified: true, errors: [] },
        binding: mode === "disabled" ? undefined : { runtimeDigest: "a".repeat(64) },
      },
    },
  };
}

test("release gate accepts every healthy effective runtime contract", () => {
  for (const mode of ["disabled", "shadow", "v2-write", "cutover"]) {
    assert.doesNotThrow(() => assertRuntimeDiagnostic(report(mode), "a".repeat(64)), mode);
  }
  assert.doesNotThrow(() => assertRuntimeDiagnostic(report("cutover", "auto"), "a".repeat(64)));
  assert.doesNotThrow(() => assertRuntimeDiagnostic(report("disabled", "auto"), "a".repeat(64)));
  assert.doesNotThrow(() => assertRuntimeDiagnostic({
    runtimeDiagnostic: {
      ok: true,
      status: "disabled",
      configuredMode: "disabled",
      receiptPresent: false,
      issues: [],
    },
  }));
});

test("release gate rejects cutover receipts that omit required active surfaces", () => {
  const invalid = report("cutover");
  invalid.runtimeDiagnostic.receipt.runtime.contextEngineRegistered = false;
  assert.throws(
    () => assertRuntimeDiagnostic(invalid, "a".repeat(64)),
    /runtime receipt contract is not satisfied/,
  );
});

test("release gate rejects readiness or runtime binding drift", () => {
  const blocked = report("cutover");
  blocked.runtimeDiagnostic.receipt.readiness.bindingVerified = false;
  assert.throws(
    () => assertRuntimeDiagnostic(blocked, "a".repeat(64)),
    /runtime readiness contract is not satisfied/,
  );
  assert.throws(
    () => assertRuntimeDiagnostic(report("cutover"), "b".repeat(64)),
    /runtime readiness contract is not satisfied/,
  );
});
