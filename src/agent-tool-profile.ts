export const AGENT_TOOL_PROFILES = [
  "read-only",
  "memory-write",
  "self-improvement",
  "operator",
  "operator-secret-index",
] as const;

export type AgentToolProfile = typeof AGENT_TOOL_PROFILES[number];

export const DEFAULT_AGENT_TOOL_PROFILE: AgentToolProfile = "memory-write";

export function isAgentToolProfile(value: unknown): value is AgentToolProfile {
  return typeof value === "string"
    && (AGENT_TOOL_PROFILES as readonly string[]).includes(value);
}

export function agentToolCapabilities(profile: AgentToolProfile): {
  memoryWrites: boolean;
  operator: boolean;
  selfImprovement: boolean;
  secretIndex: boolean;
} {
  const operator = profile === "operator" || profile === "operator-secret-index";
  return {
    memoryWrites: profile !== "read-only",
    operator,
    selfImprovement: profile === "self-improvement" || operator,
    secretIndex: profile === "operator-secret-index",
  };
}
