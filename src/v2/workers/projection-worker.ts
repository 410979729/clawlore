import { randomUUID } from "node:crypto";
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

export interface ProjectionWorkerOptionsV2 {
  owner?: string;
  leaseDurationMs?: number;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;

function errorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return `projection_${name.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
}

function isCurrentProjectionMutation(row: ProjectionOutboxRowV2, memory: MemoryRecordV2 | null): boolean {
  if (row.operation === "purge") return memory === null;
  if (!memory || !row.revisionId || memory.revisionId !== row.revisionId) return false;
  if (row.operation === "delete") return memory.lifecycle === "archived";
  return memory.lifecycle !== "archived" && memory.lifecycle !== "purged";
}

export class ProjectionWorkerV2 {
  private readonly adapters: Map<string, ProjectionAdapterV2>;
  private readonly owner: string;
  private readonly leaseDurationMs: number;

  constructor(
    private readonly truth: TruthStoreV2Port,
    adapters: ProjectionAdapterV2[],
    options: ProjectionWorkerOptionsV2 = {},
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.projection, adapter]));
    this.owner = options.owner ?? `projection-worker:${randomUUID()}`;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  }

  async run(limit = 100): Promise<ProjectionWorkerRunV2> {
    const failures: ProjectionWorkerRunV2["failures"] = [];
    let processed = 0;
    const attempted: string[] = [];
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    while (attempted.length < boundedLimit) {
      const claim = this.truth.claimNextOutbox({
        owner: this.owner,
        leaseDurationMs: this.leaseDurationMs,
        excludeOutboxIds: attempted,
      });
      if (!claim) break;
      const row = claim.row;
      attempted.push(row.outboxId);
      const adapter = this.adapters.get(row.projection);
      if (!adapter) {
        const code = "projection_adapter_missing";
        const recorded = this.truth.recordOutboxFailure(claim, code);
        failures.push({
          outboxId: row.outboxId,
          projection: row.projection,
          errorCode: recorded ? code : "projection_claim_lost",
        });
        continue;
      }
      let leaseLost = false;
      const renewalTimer = setInterval(() => {
        try {
          if (!this.truth.renewOutboxClaim(claim, this.leaseDurationMs)) leaseLost = true;
        } catch {
          leaseLost = true;
        }
      }, Math.max(50, Math.floor(this.leaseDurationMs / 3)));
      renewalTimer.unref?.();
      try {
        const memory = this.truth.get(row.itemId);
        // A newer truth mutation may commit while an older lease is in flight.
        // Obsolete rows complete without projection so late upserts cannot
        // cross a correction/archive/purge tombstone.
        if (isCurrentProjectionMutation(row, memory)) await adapter.apply(row, memory);
        if (!leaseLost && this.truth.markOutboxProcessed(claim)) {
          processed += 1;
        } else {
          failures.push({
            outboxId: row.outboxId,
            projection: row.projection,
            errorCode: "projection_claim_lost",
          });
        }
      } catch (error) {
        const code = errorCode(error);
        const recorded = !leaseLost && this.truth.recordOutboxFailure(claim, code);
        failures.push({
          outboxId: row.outboxId,
          projection: row.projection,
          errorCode: recorded ? code : "projection_claim_lost",
        });
      } finally {
        clearInterval(renewalTimer);
      }
    }
    return { processed, failed: failures.length, failures };
  }
}
