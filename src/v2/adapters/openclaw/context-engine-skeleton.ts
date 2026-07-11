export type ContextEngineActivationV2 = "compatibility" | "native-opt-in";

export interface ContextEngineHostCapabilitiesV2 {
  ingest: boolean;
  assemble: boolean;
  afterTurn: boolean;
  maintain: boolean;
  compact: boolean;
  subagentLifecycle: boolean;
  tokenBudget: boolean;
  abortSignal: boolean;
}

export interface ContextEngineNegotiationV2 {
  selected: ContextEngineActivationV2;
  canActivateNative: boolean;
  missingCapabilities: string[];
  reason: string;
}

const REQUIRED_NATIVE_CAPABILITIES = [
  "ingest", "assemble", "afterTurn", "maintain", "compact",
  "subagentLifecycle", "tokenBudget", "abortSignal",
] as const;

export function negotiateContextEngineV2(input: {
  requested: ContextEngineActivationV2;
  host: Partial<ContextEngineHostCapabilitiesV2>;
}): ContextEngineNegotiationV2 {
  const missingCapabilities = REQUIRED_NATIVE_CAPABILITIES.filter((name) => input.host[name] !== true);
  if (input.requested !== "native-opt-in") {
    return {
      selected: "compatibility", canActivateNative: missingCapabilities.length === 0,
      missingCapabilities, reason: "compatibility_mode_selected",
    };
  }
  if (missingCapabilities.length > 0) {
    return {
      selected: "compatibility", canActivateNative: false, missingCapabilities,
      reason: "native_capability_negotiation_failed",
    };
  }
  return {
    selected: "native-opt-in", canActivateNative: true, missingCapabilities: [],
    reason: "native_capabilities_confirmed",
  };
}

export class ClawLoreContextEngineSkeletonV2 {
  readonly id = "clawlore-v2";
  readonly version = 1;

  constructor(readonly negotiation: ContextEngineNegotiationV2) {}

  assertNativeActivationAllowed(): void {
    if (this.negotiation.selected !== "native-opt-in" || !this.negotiation.canActivateNative) {
      throw new Error(`ContextEngine activation denied: ${this.negotiation.reason}`);
    }
  }
}
