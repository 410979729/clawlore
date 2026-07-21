import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  isSqliteConnectionPoisoned,
  withSqliteSavepoint,
} = jiti("../src/sqlite-savepoint.ts");

test("a connection is explicitly poisoned and retired when both savepoint and full rollback fail", () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-savepoint-poison-"));
  const path = join(root, "poison.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE durable_rows(value TEXT NOT NULL)");
  let closeCalls = 0;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql) => {
          const statement = String(sql);
          if (statement.startsWith("ROLLBACK TO SAVEPOINT")) {
            throw new Error("synthetic rollback-to failure");
          }
          if (statement === "ROLLBACK") throw new Error("synthetic full rollback failure");
          return target.exec(statement);
        };
      }
      if (property === "close") {
        return () => { closeCalls += 1; target.close(); };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    assert.throws(
      () => withSqliteSavepoint(wrapped, "poison_test", () => {
        wrapped.prepare("INSERT INTO durable_rows(value) VALUES (?)").run("partial");
        throw new Error("primary mutation failure");
      }),
      (error) => {
        assert.equal(error.name, "SqliteSavepointCleanupError");
        assert.match(error.message, /primary mutation failure/);
        assert.equal(error.connectionPoisoned, true);
        assert.equal(error.errors.length, 3);
        return true;
      },
    );
    assert.equal(isSqliteConnectionPoisoned(wrapped), true);
    assert.equal(closeCalls, 1);
    assert.throws(
      () => withSqliteSavepoint(wrapped, "reuse_test", () => undefined),
      /poisoned and cannot be reused/,
    );

    const external = new DatabaseSync(path);
    try {
      assert.equal(external.prepare("SELECT COUNT(*) AS n FROM durable_rows").get().n, 0);
    } finally {
      external.close();
    }
  } finally {
    try { db.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
