function scalar(db, sql, ...params) {
    const row = db.prepare(sql).get(...params);
    return Number(Object.values(row)[0] ?? 0);
}
export async function finalizeLivePrincipalScopeVectorsV1(input) {
    const db = await input.store.getSqlTruthDb();
    if (!db)
        throw new Error("principal-scope vector finalization requires SQL truth");
    const migration = db.prepare(`SELECT * FROM clawlore_principal_scope_migrations
    WHERE migration_id=?`).get(input.migrationId);
    if (!migration)
        throw new Error("principal-scope migration receipt is missing");
    if (migration.plan_digest !== input.expectedPlanDigest) {
        throw new Error("principal-scope vector finalization plan digest mismatch");
    }
    const status = String(migration.status);
    if (status !== "truth_applied_vector_pending" && status !== "complete") {
        throw new Error("principal-scope migration is not ready for vector finalization");
    }
    const targetScope = String(migration.target_scope);
    const principalHash = String(migration.principal_hash);
    const items = db.prepare(`SELECT memory_id,original_scope
    FROM clawlore_principal_scope_migration_items
    WHERE migration_id=? ORDER BY memory_id`).all(input.migrationId);
    if (items.length !== Number(migration.rows_applied) || items.length <= 0) {
        throw new Error("principal-scope migration item coverage is incomplete");
    }
    const vectorScopeRowsChanged = Number(migration.vector_repair_rows);
    if (!Number.isInteger(vectorScopeRowsChanged)
        || vectorScopeRowsChanged < 0
        || vectorScopeRowsChanged > items.length)
        throw new Error("principal-scope stored vector repair coverage is invalid");
    let vectorsReconciledThisRun = 0;
    for (const item of items) {
        const truth = await input.store.getById(item.memory_id, [targetScope]);
        if (!truth || truth.scope !== targetScope) {
            throw new Error("principal-scope truth row is missing from the target scope");
        }
        const before = await input.store.getVectorEntryById(item.memory_id);
        if (!before)
            throw new Error("principal-scope vector companion row is missing");
        if (before.scope !== targetScope) {
            if (before.scope !== item.original_scope
                || scalar(db, `SELECT COUNT(*) FROM vector_companion_repair_outbox
          WHERE memory_id=? AND operation='principal-scope-assignment'`, item.memory_id) !== 1)
                throw new Error("principal-scope vector source or repair intent drifted");
            const changed = await input.scopeUpdater.updateScope(item.memory_id, item.original_scope, targetScope);
            if (!changed)
                throw new Error("principal-scope vector updater did not report the required change");
            vectorsReconciledThisRun += 1;
        }
        if (await input.scopeUpdater.getScope(item.memory_id) !== targetScope) {
            throw new Error("principal-scope vector companion did not converge to the target scope");
        }
    }
    const completedAt = status === "complete" && migration.completed_at
        ? String(migration.completed_at)
        : (input.now?.() ?? new Date()).toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
        db.prepare(`DELETE FROM vector_companion_repair_outbox
      WHERE operation='principal-scope-assignment' AND memory_id IN (
        SELECT memory_id FROM clawlore_principal_scope_migration_items WHERE migration_id=?
      )`).run(input.migrationId);
        const pendingRepairRows = scalar(db, `SELECT COUNT(*) FROM vector_companion_repair_outbox o
      JOIN clawlore_principal_scope_migration_items m ON m.memory_id=o.memory_id
      WHERE m.migration_id=?`, input.migrationId);
        if (pendingRepairRows !== 0) {
            throw new Error("principal-scope vector repair debt remains after reconciliation");
        }
        if (status !== "complete") {
            const result = db.prepare(`UPDATE clawlore_principal_scope_migrations
        SET status='complete',completed_at=?
        WHERE migration_id=? AND status='truth_applied_vector_pending'`).run(completedAt, input.migrationId);
            if (Number(result.changes) !== 1)
                throw new Error("principal-scope completion receipt update was not exact");
        }
        const transactionIntegrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
        const transactionForeignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
        if (transactionIntegrity !== "ok" || transactionForeignKeyViolations !== 0) {
            throw new Error("principal-scope vector completion database verification failed");
        }
        db.exec("COMMIT");
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* preserve original error */ }
        throw error;
    }
    const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get())[0]);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    if (integrity !== "ok" || foreignKeyViolations !== 0) {
        throw new Error("principal-scope vector completion postcheck failed");
    }
    return {
        schemaVersion: 1,
        phase: "clawlore-live-principal-scope-vector-finalize",
        migrationId: input.migrationId,
        status: "complete",
        idempotentReplay: status === "complete",
        planDigest: input.expectedPlanDigest,
        targetScope,
        principalHash,
        rowsVerified: items.length,
        vectorScopeRowsChanged,
        vectorsReconciledThisRun,
        pendingRepairRows: 0,
        completedAt,
        database: { integrity: "ok", foreignKeyViolations: 0 },
        runtime: {
            contextEngineEnabled: false,
            promptMutationEnabled: false,
            finalRecallCutoverEnabled: false,
        },
    };
}
