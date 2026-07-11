import type { ProjectionOutboxRowV2, TruthStoreV2Port } from "../application/ports/truth-store.js";
import type { MemoryRecordV2 } from "../domain/memory-record.js";

export interface ProjectionAdapterV2 {
  projection: ProjectionOutboxRowV2["projection"];
  apply(row: ProjectionOutboxRowV2, memory: MemoryRecordV2 | null): Promise<void>;
}

export interface ProjectionWorkerRunV2 {
  processed: number;
  failed: number;
  failures: Array<{ outboxId: string; projection: string; errorCode: string }>;
}

function errorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return `projection_${name.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
}

export class ProjectionWorkerV2 {
  private readonly adapters: Map<string, ProjectionAdapterV2>;

  constructor(private readonly truth: TruthStoreV2Port, adapters: ProjectionAdapterV2[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.projection, adapter]));
  }

  async run(limit = 100): Promise<ProjectionWorkerRunV2> {
    const failures: ProjectionWorkerRunV2["failures"] = [];
    let processed = 0;
    for (const row of this.truth.listPendingOutbox(limit)) {
      const adapter = this.adapters.get(row.projection);
      if (!adapter) {
        const code = "projection_adapter_missing";
        this.truth.recordOutboxFailure(row.outboxId, code);
        failures.push({ outboxId: row.outboxId, projection: row.projection, errorCode: code });
        continue;
      }
      try {
        await adapter.apply(row, this.truth.get(row.itemId));
        this.truth.markOutboxProcessed(row.outboxId);
        processed += 1;
      } catch (error) {
        const code = errorCode(error);
        this.truth.recordOutboxFailure(row.outboxId, code);
        failures.push({ outboxId: row.outboxId, projection: row.projection, errorCode: code });
      }
    }
    return { processed, failed: failures.length, failures };
  }
}
