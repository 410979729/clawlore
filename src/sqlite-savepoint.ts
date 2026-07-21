type SqliteDatabase = {
  exec(sql: string): unknown;
  close?: () => void;
};

const poisonedConnections = new WeakSet<object>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSavepointName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("SQLite savepoint name is invalid");
  }
}

export class SqliteSavepointCleanupError extends AggregateError {
  readonly primaryError: unknown;
  readonly cleanupErrors: readonly unknown[];
  readonly connectionPoisoned: boolean;

  constructor(input: {
    savepoint: string;
    primaryError: unknown;
    cleanupErrors: unknown[];
    connectionPoisoned: boolean;
  }) {
    const suffix = input.connectionPoisoned ? "; connection retired" : "; full rollback succeeded";
    super(
      [input.primaryError, ...input.cleanupErrors],
      `SQLite savepoint ${input.savepoint} failed: ${errorMessage(input.primaryError)}; `
        + `savepoint cleanup also failed${suffix}`,
      { cause: input.primaryError },
    );
    this.name = "SqliteSavepointCleanupError";
    this.primaryError = input.primaryError;
    this.cleanupErrors = input.cleanupErrors;
    this.connectionPoisoned = input.connectionPoisoned;
  }
}

export function isSqliteConnectionPoisoned(db: object): boolean {
  return poisonedConnections.has(db);
}

/**
 * Runs one SQLite unit of work behind a named savepoint.
 *
 * A failed ROLLBACK TO must never be followed by RELEASE: at top level that
 * would commit the partial transaction. We instead attempt a full rollback.
 * If even the full rollback fails, the connection is poisoned and retired so
 * no caller can unknowingly continue on an indeterminate transaction state.
 */
export function withSqliteSavepoint<T>(
  db: SqliteDatabase,
  savepoint: string,
  operation: () => T,
  options: { onPoisoned?: (db: SqliteDatabase) => void } = {},
): T {
  assertSavepointName(savepoint);
  if (isSqliteConnectionPoisoned(db)) {
    throw new Error("SQLite connection is poisoned and cannot be reused");
  }

  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (primaryError) {
    const cleanupErrors: unknown[] = [];
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    } catch (rollbackToError) {
      cleanupErrors.push(rollbackToError);
      let connectionPoisoned = false;
      try {
        db.exec("ROLLBACK");
      } catch (fullRollbackError) {
        cleanupErrors.push(fullRollbackError);
        connectionPoisoned = true;
        poisonedConnections.add(db);
        try {
          if (options.onPoisoned) options.onPoisoned(db);
          else db.close?.();
        } catch (retireError) {
          cleanupErrors.push(retireError);
        }
      }
      throw new SqliteSavepointCleanupError({
        savepoint,
        primaryError,
        cleanupErrors,
        connectionPoisoned,
      });
    }

    try {
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (releaseError) {
      cleanupErrors.push(releaseError);
      let connectionPoisoned = false;
      try {
        db.exec("ROLLBACK");
      } catch (fullRollbackError) {
        cleanupErrors.push(fullRollbackError);
        connectionPoisoned = true;
        poisonedConnections.add(db);
        try {
          if (options.onPoisoned) options.onPoisoned(db);
          else db.close?.();
        } catch (retireError) {
          cleanupErrors.push(retireError);
        }
      }
      throw new SqliteSavepointCleanupError({
        savepoint,
        primaryError,
        cleanupErrors,
        connectionPoisoned,
      });
    }
    throw primaryError;
  }
}
