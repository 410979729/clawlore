# ClawLore v1 fourth independent-audit remediation run — 2026-07-15

## Decision

The fourth independent re-audit findings were accepted. Both release blockers
and all five should-fix findings were remediated in the source candidate. The
candidate remains **not authorized for publication, deployment, or V2
cutover** until Tianxuan independently accepts the exact clean commit.

## Remediated release blockers

### Deleted companion rows cannot become truth after restart

- Ordinary startup performs no vector-to-truth reconciliation.
- Existing SQL truth is the only runtime authority; companion-only ids remain
  stale repair targets and are never imported.
- If `memory.sqlite3` is missing while LanceDB or sqlite-bruteforce contains
  rows, initialization fails before creating a replacement truth database with
  stable code `CLAWLORE_SQL_TRUTH_MIGRATION_REQUIRED`.
- Legacy import remains an explicit migration concern rather than a broad
  startup catch path.
- Restart fault injection covers both vector backends: store, fail companion
  delete, delete truth, close, reopen, and verify get/vector/BM25 remain empty
  while durable delete debt survives.

### File privacy enforcement is part of the SQL transaction

- Database/WAL/SHM `0600` chmod and mode verification occur before releasing
  the SQLite savepoint.
- A permission-enforcement failure now rolls back truth, FTS, and vector intent
  instead of reporting failure after persistence.
- Upsert, delete, supersede, bulk delete, reconcile, repair-debt creation, and
  repair-debt clear all use the same durable mutation wrapper.
- Windows explicitly treats its state-directory ACL as authority rather than
  manufacturing a post-commit POSIX mode failure.

## Remediated should-fix findings

- Playbook version receipts now retain every durable field: evidence anchors,
  related skills, environment constraints, reuse policy, counters, source
  episode, supersession, timestamps, and metadata. Snapshots are recursively
  secret/path-redacted before storage.
- The two remaining duplicate/conflict catch paths use keyed redacted
  diagnostic summaries. Tests reject raw interpolation for both `error` and
  `err` variable spellings.
- SQL authority initialization failures release local handles and latch one
  stable failure. Repeated requests do not reconnect or log-storm; only the
  explicit `reopenAfterRecovery()` boundary retries after restoration.
- Source-only release gates reject any post-build dirty worktree exactly as
  live-artifact gates do.
- Bounded vector hydration records scan-budget exhaustion count/time and marks
  companion repair required instead of silently returning an unexplained short
  result.

## Regression evidence

Focused regression covers:

- stale deleted rows across a real close/reopen cycle on LanceDB and
  sqlite-bruteforce;
- missing SQL authority with retained companion rows on both backends;
- permission failure rollback for upsert, delete, supersede, and repair-debt
  clear;
- complete post-state playbook snapshots plus recursive sensitive-field
  redaction;
- 100 concurrent calls during one authority outage, one stable failure/log,
  followed by explicit recovery;
- 5,000-row scan exhaustion with explicit diagnostics;
- source-only/live dirty-tree refusal and raw-error interpolation canaries.

The pre-commit full regression passed 321/321 tests. Typecheck, build, vector
repair smoke, the 124-case deterministic recall matrix, and the 200,000-row
SQLite FTS baseline also passed. The exact clean committed candidate must repeat
the full source gate before handoff; that gate includes clean post-build state,
SBOM, extracted npm-pack content scan, and official-registry production audit.

## Truth and rollout boundary

- Live remains `scope-recall-openclaw@1.1.0`; this candidate was not copied into
  the live extension directory.
- No live config, database, plugin identity, memory slot, service, Telegram
  policy, or V2 data-plane change is part of this source remediation.
- V2 still has zero active rows, so cutover remains fail-closed regardless of
  source-gate success.
- The 124-case matrix and 200,000-row FTS run remain deterministic engineering
  evidence, not independent human relevance or commercial-scale evidence.
- This project has no `TODO-enterprise-memory-core.md`; the maintained handoff
  truth set is this report, `docs/clawlore/project-handoff.md`, and the workspace
  daily record. No placeholder was created.

## Next gate

Provide Tianxuan the exact clean commit, recursive runtime digest, source-gate
output, this report, and the prior three audit-remediation reports. Repository
push and any live deployment remain separately gated decisions.
