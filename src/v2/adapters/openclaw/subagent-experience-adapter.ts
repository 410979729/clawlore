import type { ContextPackV1 } from "../../domain/context-pack.js";
import type { EpisodeOutcomeV2, SubagentSnapshotV2 } from "../../domain/experience.js";
import type { MemoryAddressV2 } from "../../domain/memory-address.js";
import type { SubagentExperienceServiceV2 } from "../../application/subagent-experience-service.js";

export class OpenClawSubagentExperienceAdapterV2 {
  constructor(private readonly service: SubagentExperienceServiceV2) {}

  prepareSubagentSpawn(input: {
    mode: "isolated" | "fork";
    parentSessionId: string;
    childSessionId: string;
    runId: string;
    taskGoal: string;
    actor: MemoryAddressV2;
    contextPack: ContextPackV1;
    explicitlyAuthorizedMemoryIds?: string[];
  }): SubagentSnapshotV2 {
    return this.service.prepareSpawn(input);
  }

  onSubagentEnded(input: {
    snapshotId: string;
    childSessionId: string;
    taskClass: string;
    outcome: EpisodeOutcomeV2;
    toolReceiptIds?: string[];
    evidence?: string[];
  }) {
    return this.service.onSubagentEnded(input);
  }
}
