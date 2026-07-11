export class ProjectionConvergenceInspectorV2 {
    truth;
    now;
    constructor(truth, now = () => new Date()) {
        this.truth = truth;
        this.now = now;
    }
    inspect(handle) {
        if (handle.schemaVersion !== 1 || handle.status !== "pending") {
            throw new Error("unsupported projection receipt handle");
        }
        if (handle.expected.length !== handle.outboxIds.length) {
            throw new Error("projection receipt handle is malformed");
        }
        const rows = new Map(this.truth.inspectOutbox(handle.outboxIds).map((row) => [row.outboxId, row]));
        const projections = handle.expected.map((projection, index) => {
            const outboxId = handle.outboxIds[index];
            const row = rows.get(outboxId);
            if (!row || row.projection !== projection || row.operation !== handle.operation) {
                return { projection, outboxId, status: "missing", attempts: 0 };
            }
            if (row.processedAt) {
                return {
                    projection, outboxId, status: "processed", attempts: row.attempts,
                    availableAt: row.availableAt, processedAt: row.processedAt,
                };
            }
            return {
                projection, outboxId, status: row.attempts > 0 ? "retrying" : "pending",
                attempts: row.attempts, availableAt: row.availableAt, errorCode: row.lastError,
            };
        });
        const status = projections.every((item) => item.status === "processed")
            ? "converged"
            : projections.some((item) => item.status === "retrying")
                ? "retrying"
                : "pending";
        return { schemaVersion: 1, status, operation: handle.operation, checkedAt: this.now().toISOString(), projections };
    }
}
