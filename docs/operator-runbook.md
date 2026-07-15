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

Do not continue to live rollout until all source gates pass and an independent
audit approves the exact candidate commit.

If SQL truth cannot initialize because the database is corrupt, unreadable, a
directory, or schema-incompatible, ClawLore intentionally refuses reads and
writes with `CLAWLORE_SQL_TRUTH_UNAVAILABLE`. Do not enable vector-only recall.
Restore or repair the SQLite authority from a verified backup, run doctor and
the vector-repair dry run, then repeat the clean source/live gate.

## Live Rollout

1. Record the candidate commit and recursive artifact digest.
2. Back up the live extension, `openclaw.json`, and SQLite truth store.
3. Stage exactly one canonical `extensions/clawlore` copy. Do not enable the
   legacy and canonical plugin copies together because they expose the same
   memory slot and tool contracts.
4. Move the config entry and memory slot to `clawlore` while preserving its
   `dbPath`, conservative runtime flags, and `clawloreV2` controls.
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
