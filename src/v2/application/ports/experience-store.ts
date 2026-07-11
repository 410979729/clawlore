import type {
  ChildScratchV2,
  ExperienceEpisodeV2,
  ExperienceEventV2,
  ProceduralPlaybookV2,
  SubagentSnapshotV2,
} from "../../domain/experience.js";

export interface ExperienceStoreV2Port {
  saveSnapshot(snapshot: SubagentSnapshotV2): void;
  getSnapshot(snapshotId: string): SubagentSnapshotV2 | null;
  saveScratch(scratch: ChildScratchV2): void;
  finalizeSnapshot(snapshot: SubagentSnapshotV2, episode: ExperienceEpisodeV2): void;
  getEpisode(episodeId: string): ExperienceEpisodeV2 | null;
  updateEpisode(episode: ExperienceEpisodeV2): void;
  listEpisodes(episodeIds: string[]): ExperienceEpisodeV2[];
  savePlaybook(playbook: ProceduralPlaybookV2): void;
  getPlaybook(playbookId: string): ProceduralPlaybookV2 | null;
  updatePlaybook(playbook: ProceduralPlaybookV2): void;
  appendEvent(event: ExperienceEventV2): void;
}
