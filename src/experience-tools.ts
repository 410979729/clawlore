/**
 * Stable Experience-tool facade. Query-safe tools and operator-only tools are
 * registered separately so the management boundary stays explicit.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  type ExperienceToolContext,
  type ExperienceToolsOptions,
} from "./experience-tool-runtime-policy.js";
import {
  registerEpisodeCompleteTool,
  registerEpisodeCreateTool,
} from "./experience-episode-tools.js";
import {
  registerPlaybookCreateTool,
  registerPlaybookFeedbackTool,
  registerPlaybookInspectTool,
  registerPlaybookSearchTool,
} from "./experience-playbook-tools.js";
import {
  registerExperiencePreflightTool,
  registerExperienceStatsTool,
} from "./experience-query-tools.js";
import {
  registerDigestRecoveryTool,
  registerDigestReportTool,
  registerDigestRunTool,
  registerExperiencePromoteTool,
  registerForgettingReportTool,
  registerForgettingRunTool,
  registerGovernanceCleanupReportTool,
  registerGovernanceCleanupRunTool,
  registerGraphHygieneReportTool,
  registerGraphHygieneRunTool,
  registerJournalRecoveryReportTool,
  registerJournalRecoveryRunTool,
  registerMemoryCandidatePromotionReportTool,
  registerMemoryCandidatePromotionRunTool,
  registerOperatorDashboardTool,
} from "./experience-operator-tools.js";
import {
  registerExperienceReplayTool,
  registerPlaybookReviewTool,
} from "./experience-review-tools.js";

export {
  EXPERIENCE_TOOL_NAMES,
  resolveExperienceRuntime,
  safeExperienceToolFailure,
} from "./experience-tool-runtime-policy.js";
export type {
  ExperienceToolContext,
  ExperienceToolsOptions,
} from "./experience-tool-runtime-policy.js";
export {
  registerEpisodeCompleteTool,
  registerEpisodeCreateTool,
} from "./experience-episode-tools.js";
export {
  registerPlaybookCreateTool,
  registerPlaybookFeedbackTool,
  registerPlaybookInspectTool,
  registerPlaybookSearchTool,
} from "./experience-playbook-tools.js";
export {
  registerExperiencePreflightTool,
  registerExperienceStatsTool,
} from "./experience-query-tools.js";

export function registerExperienceTools(
  api: OpenClawPluginApi,
  context: ExperienceToolContext,
  options: ExperienceToolsOptions = {},
): void {
  const apiWithMetadata: OpenClawPluginApi = {
    ...api,
    registerTool(factory, metadata) {
      if (metadata?.name) {
        api.registerTool(factory, metadata);
        return;
      }
      const probe = factory({});
      const name = probe && typeof probe === "object" && typeof (probe as { name?: unknown }).name === "string"
        ? String((probe as { name: string }).name)
        : "";
      if (!name) {
        throw new Error("Experience Kernel tool registration requires a tool name");
      }
      api.registerTool(factory, { name });
    },
  };

  registerPlaybookSearchTool(apiWithMetadata, context);
  registerPlaybookInspectTool(apiWithMetadata, context);
  registerExperiencePreflightTool(apiWithMetadata, context);

  if (options.enableManagementTools === true) {
    registerExperienceStatsTool(apiWithMetadata, context);
    registerExperienceReplayTool(apiWithMetadata, context);
    registerEpisodeCreateTool(apiWithMetadata, context);
    registerEpisodeCompleteTool(apiWithMetadata, context);
    registerPlaybookCreateTool(apiWithMetadata, context);
    registerPlaybookFeedbackTool(apiWithMetadata, context);
    registerExperiencePromoteTool(apiWithMetadata, context);
    registerForgettingReportTool(apiWithMetadata, context);
    registerForgettingRunTool(apiWithMetadata, context);
    registerGovernanceCleanupReportTool(apiWithMetadata, context);
    registerGovernanceCleanupRunTool(apiWithMetadata, context);
    registerMemoryCandidatePromotionReportTool(apiWithMetadata, context);
    registerMemoryCandidatePromotionRunTool(apiWithMetadata, context);
    registerGraphHygieneReportTool(apiWithMetadata, context);
    registerGraphHygieneRunTool(apiWithMetadata, context);
    registerJournalRecoveryReportTool(apiWithMetadata, context);
    registerJournalRecoveryRunTool(apiWithMetadata, context);
    registerDigestReportTool(apiWithMetadata, context);
    registerDigestRunTool(apiWithMetadata, context);
    registerDigestRecoveryTool(apiWithMetadata, context);
    registerOperatorDashboardTool(apiWithMetadata, context);
    registerPlaybookReviewTool(apiWithMetadata, context);
  }
}
