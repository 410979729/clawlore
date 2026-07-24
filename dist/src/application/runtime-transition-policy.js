/**
 * Prevents a transition mode from coexisting with a legacy writer that cannot
 * maintain V1/V2 parity. Release-readiness checks are deliberately separate:
 * this policy describes the static runtime configuration only.
 */
export function runtimeTransitionPolicyBlocksV1(input) {
    if (input.mode !== "v2-write" && input.mode !== "cutover")
        return [];
    const prefix = input.mode === "cutover" ? "cutover" : "v2_write";
    const blocks = [];
    const requiredContextEngine = input.mode === "cutover" ? "native-opt-in" : "compatibility";
    if (input.contextEngine !== requiredContextEngine) {
        blocks.push(input.mode === "cutover"
            ? "cutover_requires_native_context_engine"
            : "v2_write_requires_compatibility_context_engine");
    }
    if (input.agentToolProfile !== "v2-write") {
        blocks.push(`${prefix}_requires_store_only_tool_profile`);
    }
    if (input.autoCapture || input.smartExtraction || input.sessionStrategy !== "none") {
        blocks.push(`${prefix}_requires_legacy_automatic_writers_disabled`);
    }
    return blocks;
}
