import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  createConfiguredLlmRuntime,
  type ConfiguredLlmRuntime,
} from "./core-memory-runtime.js";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import type { PluginConfig } from "./plugin-config.js";
import { requiresBackgroundLlmRuntime } from "./background-llm-policy.js";

/** Composes the shared LLM transport used by independent background features. */
export function initializeBackgroundLlmRuntime(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  logRegistration(message: string): void;
}): ConfiguredLlmRuntime | null {
  if (!requiresBackgroundLlmRuntime(params.config)) return null;

  try {
    const runtime = createConfiguredLlmRuntime(params.api, params.config);
    if (params.config.taskExperienceCapture?.enabled === true) {
      params.logRegistration(
        `task-experience: review LLM ready (model: ${runtime.model}, timeoutMs: ${runtime.timeoutMs})`,
      );
    }
    return runtime;
  } catch (error) {
    params.api.logger.warn(
      `clawlore: background LLM init failed; LLM-reviewed features are unavailable: ${diagnosticErrorSummary(error)}`,
    );
    return null;
  }
}
