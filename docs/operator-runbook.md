# ClawLore Operator Runbook

Status: Phase 7 commercial release hardening baseline.

Use this runbook when preparing or validating a live
ClawLore rollout.

## Source Gate

Run from the plugin workspace:

```bash
npm ci --ignore-scripts --include=dev
npm run preflight:dependencies
npm run release:gate:source
```

The source gate includes the full test/typecheck/build/benchmark/package scan,
SBOM, dependency-integrity preflight, and an advisory audit pinned to the
official npm registry. A missing dependency, advisory endpoint failure, or
transport failure is a red gate; none may be interpreted as zero findings.
The gate also requires the candidate worktree to remain clean after build in
both source-only and live-artifact modes; generated artifact drift is a red
gate. It packs the real npm tarball, installs that tarball into an empty
production-only directory, resolves the supported OpenClaw SDK, and loads the
installed `clawlore`, `scope-recall`, and `memory-pro` CLI registration surface.
The package metadata marks `smoke:packed-runtime` as the only published runtime
script; all other npm scripts require a source checkout and are not public
installed-package capabilities.

Do not continue to live rollout until all source gates pass and an independent
audit approves the exact candidate commit.

If SQL truth cannot initialize because the database is corrupt, unreadable, a
directory, or schema-incompatible, ClawLore intentionally refuses reads and
writes with `CLAWLORE_SQL_TRUTH_UNAVAILABLE`. Do not enable vector-only recall.
Restore or repair the SQLite authority from a verified backup, run doctor and
the vector-repair dry run, then repeat the clean source/live gate.

If `memory.sqlite3` is missing, zero-length, schema-less, marker-less at zero
rows, or otherwise lacks an established authority while the vector companion
still contains rows, startup stops with
`CLAWLORE_SQL_TRUTH_MIGRATION_REQUIRED`. Ordinary startup never imports
companion rows into truth. The supported recovery is restoration of a verified
SQLite authority backup, followed by `doctor` and vector-repair dry-run. This
release does not ship or support companion-to-truth recovery. In particular,
`scripts/migrate-legacy-hygiene.mjs` only repairs metadata hygiene inside an
already valid SQL authority; it is not a vector recovery command. Never rename,
truncate, recreate, or delete the truth file to force vector recovery.

New stores may create an authority only when both the SQL truth and companion
are absent/empty. The created database contains a versioned
`clawlore_sql_truth_authority` marker. A structurally complete, non-empty legacy
truth database may receive that marker only through the controlled, explicit,
backup-backed 1.1→1.2 schema upgrade; an empty or partial unmarked database is
never upgraded implicitly. Preview first, then apply with operator-reviewed
paths outside the live database directory:

```bash
openclaw clawlore authority inspect --db /path/to/memory.sqlite3
openclaw clawlore authority migrate \
  --db /path/to/memory.sqlite3 \
  --backup /private/backup/memory.sqlite3 \
  --receipt /private/receipts/clawlore-authority-migration.json

openclaw clawlore authority migrate \
  --db /path/to/memory.sqlite3 \
  --backup /private/backup/memory.sqlite3 \
  --receipt /private/receipts/clawlore-authority-migration.json \
  --apply
```

Ordinary plugin startup never performs the legacy upgrade. The apply command
requires the backup and receipt to use different, dedicated owner-only leaf
directories. Existing directories are verified but never chmod'd or have their
ACL rewritten; a shared, non-private, non-empty, root, home, temp-root, or live
database directory is rejected before any output is created. Relative paths,
symlinked parents, case aliases, the source DB, and its WAL/SHM companions are
resolved before the three paths are required to be pairwise distinct.

Before changing the source, apply creates the SQLite backup, fsyncs the backup
and its parent directory, verifies its hash and logical snapshot, and writes a
prepared receipt. The schema upgrade then takes a SQLite `BEGIN IMMEDIATE`
writer lock and compares the locked source snapshot to the durable backup;
concurrent UPDATE/INSERT/DELETE activity aborts the migration before the
authority marker is written. Quiescing the gateway is still recommended to
avoid an expected abort under traffic, but row counts alone are never accepted
as consistency evidence. The internal SQLite migration receipt is the commit
truth. If writing the external completed JSON is interrupted after commit,
re-running the same command reconstructs that receipt idempotently instead of
reapplying the migration. A completed authority refuses a second migration.

Doctor/dashboard diagnostics expose `scanBudgetExhaustions` and
`lastScanBudgetExhaustedAt`. A new exhaustion means stale companion rows
consumed the bounded 5,000-row scan before enough SQL-valid results were found.
Run vector-repair dry-run, review the debt, apply repair only under operator
authority, and then recheck diagnostics.

## Live Rollout

1. Record the candidate commit and recursive artifact digest.
2. Back up the live extension, `openclaw.json`, and SQLite truth store.
3. Stage exactly one canonical `extensions/clawlore` copy. Do not enable the
   legacy and canonical plugin copies together because they expose the same
   memory slot and tool contracts.
4. Move the config entry and memory slot to `clawlore` while preserving its
   `dbPath`, conservative runtime flags, and canonical `runtime` controls.
   Existing `clawloreV2` input is a deprecated migration alias only; do not
   write both keys unless their normalized values are identical.
   Auth commands now perform this identity move as one complete config
   migration when only the legacy entry exists. If canonical and legacy entries
   both exist with different contents, they stop without writing. OAuth login
   also refuses plaintext API-key backup material, and logout commits the
   restored config before deleting OAuth files.
5. Restart once, then run `npm run release:gate` from the clean candidate so
   recursive source/live identity and runtime smoke are checked.

## Live Smoke

Use the current OpenClaw home:

```bash
OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw plugins inspect clawlore --json

OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw clawlore doctor --json --quiet

OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw clawlore dashboard --json

OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw clawlore digest report --json

OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw clawlore experience stats --json
```

Safe recall probes should use a non-secret query and must not force memory
writes. If doctor is degraded, record the exact degraded field before deciding
whether to repair or roll back. `SQL_TRUTH_UNAVAILABLE` is not a degraded mode;
it is a fail-closed outage that requires authority-store recovery.

## Rollback

Rollback restores the legacy extension and configuration backup as one unit,
then re-runs plugin inspect, doctor, dashboard, health, and a read-only recall
probe. Do not delete the backups until the replacement has passed live smoke.
