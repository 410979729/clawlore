const CONTRACTS = Object.freeze({
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
});

/** Revalidate doctor output without assuming every healthy runtime is shadow. */
export function assertRuntimeDiagnostic(report, expectedRuntimeDigest) {
  const runtime = report?.runtimeDiagnostic;
  if (!runtime || runtime.ok !== true) {
    throw new Error("release gate failed: ClawLore runtime diagnostic did not report ok=true");
  }

  const receipt = runtime.receipt;
  const requestedMode = receipt?.runtime?.requestedMode;
  const configuredMode = runtime.configuredMode;
  if (configuredMode === "disabled" && runtime.status === "disabled" && !receipt) {
    return;
  }
  const modeMatches = configuredMode === "auto"
    ? requestedMode === "disabled" || requestedMode === "cutover"
    : requestedMode === configuredMode;
  const contract = CONTRACTS[requestedMode];
  if (
    !modeMatches
    || !contract
    || runtime.status !== contract.status
    || receipt?.runtime?.status !== contract.status
    || receipt.runtime.registeredHookCount !== contract.registeredHooks.length
    || JSON.stringify(receipt.runtime.registeredHooks) !== JSON.stringify(contract.registeredHooks)
    || receipt.runtime.writeEnabled !== contract.writeEnabled
    || receipt.runtime.promptMutationEnabled !== contract.promptMutationEnabled
    || receipt.runtime.contextEngineRegistered !== contract.contextEngineRegistered
    || !Array.isArray(receipt.runtime.blockingReasons)
    || receipt.runtime.blockingReasons.length !== 0
  ) {
    throw new Error("release gate failed: ClawLore runtime receipt contract is not satisfied");
  }

  if (requestedMode === "disabled") return;
  if (
    receipt?.readiness?.status !== "ready"
    || receipt.readiness.bindingVerified !== true
    || !Array.isArray(receipt.readiness.errors)
    || receipt.readiness.errors.length !== 0
    || (expectedRuntimeDigest && receipt?.binding?.runtimeDigest !== expectedRuntimeDigest)
  ) {
    throw new Error("release gate failed: ClawLore runtime readiness contract is not satisfied");
  }
}
