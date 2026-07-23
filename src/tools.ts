/**
 * Stable Agent-tool facade. Capability registrars live in focused modules while
 * this file preserves the historical import surface.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ToolContext } from "./tool-runtime-policy.js";
import {
  registerSelfImprovementExtractSkillTool,
  registerSelfImprovementLogTool,
  registerSelfImprovementReviewTool,
} from "./self-improvement-tools.js";
import { registerMemoryRecallTool } from "./memory-recall-tools.js";
import {
  registerMemoryStoreSecretIndexTool,
  registerMemoryStoreTool,
} from "./memory-write-tools.js";
import {
  registerMemoryForgetTool,
  registerMemoryUpdateTool,
} from "./memory-lifecycle-tools.js";
import {
  registerMemoryContextTool,
  registerMemoryDebugTool,
  registerMemoryInspectTool,
  registerMemoryListTool,
  registerMemoryStatsTool,
} from "./memory-diagnostic-tools.js";
import {
  registerMemoryArchiveTool,
  registerMemoryCompactTool,
  registerMemoryExplainRankTool,
  registerMemoryGovernTool,
  registerMemoryPromoteTool,
} from "./memory-governance-tools.js";

export {
  MEMORY_CATEGORIES,
  _resetWarnedMissingAgentIdState,
  safeToolFailure,
} from "./tool-runtime-policy.js";
export type { MdMirrorWriter } from "./tool-runtime-policy.js";
export {
  registerSelfImprovementExtractSkillTool,
  registerSelfImprovementLogTool,
  registerSelfImprovementReviewTool,
} from "./self-improvement-tools.js";
export { registerMemoryRecallTool } from "./memory-recall-tools.js";
export {
  registerMemoryStoreSecretIndexTool,
  registerMemoryStoreTool,
} from "./memory-write-tools.js";
export {
  registerMemoryForgetTool,
  registerMemoryUpdateTool,
} from "./memory-lifecycle-tools.js";
export {
  registerMemoryContextTool,
  registerMemoryDebugTool,
  registerMemoryInspectTool,
  registerMemoryListTool,
  registerMemoryStatsTool,
} from "./memory-diagnostic-tools.js";
export {
  registerMemoryArchiveTool,
  registerMemoryCompactTool,
  registerMemoryExplainRankTool,
  registerMemoryGovernTool,
  registerMemoryPromoteTool,
} from "./memory-governance-tools.js";

export function registerAllMemoryTools(
  api: OpenClawPluginApi,
  context: ToolContext,
  options: {
    allowAgentMemoryWriteTools?: boolean;
    enableManagementTools?: boolean;
    enableSelfImprovementTools?: boolean;
    secretIndexToolsEnabled?: boolean;
  } = {},
): void {
  registerMemoryRecallTool(api, context);
  if (options.allowAgentMemoryWriteTools !== false) {
    registerMemoryStoreTool(api, context);
    if (options.secretIndexToolsEnabled === true) {
      registerMemoryStoreSecretIndexTool(api, context);
    }
    registerMemoryForgetTool(api, context);
    registerMemoryUpdateTool(api, context);
  }

  if (options.enableManagementTools) {
    registerMemoryStatsTool(api, context);
    registerMemoryDebugTool(api, context);
    registerMemoryListTool(api, context);
    registerMemoryContextTool(api, context);
    registerMemoryInspectTool(api, context);
    registerMemoryGovernTool(api, context);
    registerMemoryPromoteTool(api, context);
    registerMemoryArchiveTool(api, context);
    registerMemoryCompactTool(api, context);
    registerMemoryExplainRankTool(api, context);
  }
  if (options.enableSelfImprovementTools !== false) {
    registerSelfImprovementLogTool(api, context);
    if (options.enableSelfImprovementTools === true || options.enableManagementTools) {
      registerSelfImprovementExtractSkillTool(api, context);
      registerSelfImprovementReviewTool(api, context);
    }
  }
}
