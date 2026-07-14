import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  redactDigestReportForDiagnostics,
  redactDigestRunForDiagnostics,
} = jiti("../src/diagnostics-redaction.ts");

test("doctor digest diagnostics omit user-derived examples and identifiers", () => {
  const rawRun = {
    id: "run-private",
    run_date: "2026-07-14",
    started_at: "2026-07-14T00:00:00Z",
    completed_at: "2026-07-14T00:00:01Z",
    status: "ok",
    source_count: 2,
    notes: "private conversation summary",
    examples: ["private example"],
    session: "session-private.jsonl",
    actor: "principal-private",
  };
  assert.deepEqual(redactDigestRunForDiagnostics(rawRun), {
    run_date: "2026-07-14",
    started_at: "2026-07-14T00:00:00Z",
    completed_at: "2026-07-14T00:00:01Z",
    status: "ok",
    source_count: 2,
  });

  const safe = redactDigestReportForDiagnostics({
    enabled: true,
    status: "ready",
    lastRun: rawRun,
    samples: [{ preview: "private preview", source_id: "private-source" }],
  });
  const encoded = JSON.stringify(safe);
  assert.doesNotMatch(encoded, /private|preview|source_id|notes|examples|session|actor/);
  assert.equal(safe.status, "ready");
});
