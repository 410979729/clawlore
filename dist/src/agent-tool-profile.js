export const AGENT_TOOL_PROFILES = [
    "read-only",
    "v2-write",
    "memory-write",
    "self-improvement",
    "operator",
    "operator-secret-index",
];
export const DEFAULT_AGENT_TOOL_PROFILE = "memory-write";
export function isAgentToolProfile(value) {
    return typeof value === "string"
        && AGENT_TOOL_PROFILES.includes(value);
}
export function agentToolCapabilities(profile) {
    const operator = profile === "operator" || profile === "operator-secret-index";
    return {
        memoryWrites: profile !== "read-only",
        memoryLifecycleWrites: profile !== "read-only" && profile !== "v2-write",
        operator,
        selfImprovement: profile === "self-improvement" || operator,
        secretIndex: profile === "operator-secret-index",
    };
}
