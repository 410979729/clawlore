declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    pluginConfig?: unknown;
    config?: unknown;
    registrationMode?: string;
    logger: {
      debug(...args: unknown[]): void;
      info(...args: unknown[]): void;
      warn(...args: unknown[]): void;
      error(...args: unknown[]): void;
    };
    runtime: {
      agent: {
        runEmbeddedAgent(params: Record<string, unknown>): Promise<unknown>;
      };
    };
    resolvePath(path: string): string;
    registerTool(
      factory: (toolContext?: Record<string, unknown>) => unknown,
      metadata?: { name?: string },
    ): void;
    registerCli(
      register: unknown,
      metadata?: { commands?: string[] },
    ): void;
    on(
      event: string,
      handler: (...args: any[]) => unknown,
      options?: Record<string, unknown>,
    ): void;
    registerHook(
      event: string,
      handler: (...args: any[]) => unknown,
      options?: Record<string, unknown>,
    ): void;
    registerService(service: Record<string, unknown>): void;
    registerContextEngine(
      id: string,
      factory: (context: Record<string, unknown>) => unknown | Promise<unknown>,
    ): void;
  }
}

declare module "openclaw/plugin-sdk/config-types" {
  export type SecretRef = {
    source: "env" | "file" | "exec";
    provider?: string;
    id: string;
  };

  export type OpenClawConfig = Record<string, unknown> & {
    secrets?: {
      defaults?: Record<string, string>;
      providers?: Record<string, unknown>;
    };
  };

  export function coerceSecretRef(
    value: unknown,
    defaults?: Record<string, string>,
  ): SecretRef | null;
}

declare module "openclaw/plugin-sdk/core" {
  import type { SecretRef } from "openclaw/plugin-sdk/config-types";
  export function isSecretRef(value: unknown): value is SecretRef;
  export function delegateCompactionToRuntime(params: {
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    sessionTarget?: {
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
      storePath?: string;
      threadId?: string | number;
    };
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeSettings?: Record<string, unknown>;
    runtimeContext?: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    result?: {
      summary?: string;
      firstKeptEntryId?: string;
      tokensBefore: number;
      tokensAfter?: number;
      details?: unknown;
      sessionId?: string;
      sessionTarget?: {
        agentId?: string;
        sessionId?: string;
        sessionKey?: string;
        storePath?: string;
        threadId?: string | number;
      };
      sessionFile?: string;
    };
  }>;
}

declare module "openclaw/plugin-sdk/secret-ref-runtime" {
  import type { OpenClawConfig, SecretRef } from "openclaw/plugin-sdk/config-types";

  export function resolveSecretRefValues(
    refs: SecretRef[],
    options: { config: OpenClawConfig; env?: NodeJS.ProcessEnv },
  ): Promise<Map<string, unknown>>;

  export function applyResolvedAssignments(params: {
    assignments: Array<{
      ref: SecretRef;
      path: string;
      expected: "string" | "string-or-object";
      apply: (value: unknown) => void;
    }>;
    resolved: Map<string, unknown>;
  }): void;
}

declare module "commander" {
  export interface Command {
    command(nameAndArgs: string): Command;
    alias(name: string): Command;
    description(value: string): Command;
    option(flags: string, description?: string, defaultValue?: unknown): Command;
    requiredOption(flags: string, description?: string, defaultValue?: unknown): Command;
    action(handler: (...args: any[]) => unknown): Command;
  }
}
