export type ReflectionThinkLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ReflectionErrorSignal {
  at: number;
  toolName: string;
  summary: string;
  source: "tool_error" | "tool_output";
  signature: string;
  signatureHash: string;
}

export interface ReflectionGenerationResult {
  text: string;
  usedFallback: boolean;
  promptHash: string;
  error?: string;
  runner: "embedded" | "fallback" | "cli";
}
