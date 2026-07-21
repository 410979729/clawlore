import { randomUUID } from "node:crypto";
const DEFAULT_LEASE_DURATION_MS = 30_000;
function errorCode(error) {
    const name = error instanceof Error ? error.name : "Error";
    return `projection_${name.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
}
export class ProjectionWorkerV2 {
    truth;
    adapters;
    owner;
    leaseDurationMs;
    constructor(truth, adapters, options = {}) {
        this.truth = truth;
        this.adapters = new Map(adapters.map((adapter) => [adapter.projection, adapter]));
        this.owner = options.owner ?? `projection-worker:${randomUUID()}`;
        this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    }
    async run(limit = 100) {
        const failures = [];
        let processed = 0;
        const attempted = [];
        const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
        while (attempted.length < boundedLimit) {
            const claim = this.truth.claimNextOutbox({
                owner: this.owner,
                leaseDurationMs: this.leaseDurationMs,
                excludeOutboxIds: attempted,
            });
            if (!claim)
                break;
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
                    if (!this.truth.renewOutboxClaim(claim, this.leaseDurationMs))
                        leaseLost = true;
                }
                catch {
                    leaseLost = true;
                }
            }, Math.max(50, Math.floor(this.leaseDurationMs / 3)));
            renewalTimer.unref?.();
            try {
                await adapter.apply(row, this.truth.get(row.itemId));
                if (!leaseLost && this.truth.markOutboxProcessed(claim)) {
                    processed += 1;
                }
                else {
                    failures.push({
                        outboxId: row.outboxId,
                        projection: row.projection,
                        errorCode: "projection_claim_lost",
                    });
                }
            }
            catch (error) {
                const code = errorCode(error);
                const recorded = !leaseLost && this.truth.recordOutboxFailure(claim, code);
                failures.push({
                    outboxId: row.outboxId,
                    projection: row.projection,
                    errorCode: recorded ? code : "projection_claim_lost",
                });
            }
            finally {
                clearInterval(renewalTimer);
            }
        }
        return { processed, failed: failures.length, failures };
    }
}
