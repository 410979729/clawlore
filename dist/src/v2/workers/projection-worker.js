function errorCode(error) {
    const name = error instanceof Error ? error.name : "Error";
    return `projection_${name.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
}
export class ProjectionWorkerV2 {
    truth;
    adapters;
    constructor(truth, adapters) {
        this.truth = truth;
        this.adapters = new Map(adapters.map((adapter) => [adapter.projection, adapter]));
    }
    async run(limit = 100) {
        const failures = [];
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
            }
            catch (error) {
                const code = errorCode(error);
                this.truth.recordOutboxFailure(row.outboxId, code);
                failures.push({ outboxId: row.outboxId, projection: row.projection, errorCode: code });
            }
        }
        return { processed, failed: failures.length, failures };
    }
}
