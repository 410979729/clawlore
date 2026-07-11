const REQUIRED_NATIVE_CAPABILITIES = [
    "ingest", "assemble", "afterTurn", "maintain", "compact",
    "subagentLifecycle", "tokenBudget", "abortSignal",
];
export function negotiateContextEngineV2(input) {
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
    negotiation;
    id = "clawlore-v2";
    version = 1;
    constructor(negotiation) {
        this.negotiation = negotiation;
    }
    assertNativeActivationAllowed() {
        if (this.negotiation.selected !== "native-opt-in" || !this.negotiation.canActivateNative) {
            throw new Error(`ContextEngine activation denied: ${this.negotiation.reason}`);
        }
    }
}
