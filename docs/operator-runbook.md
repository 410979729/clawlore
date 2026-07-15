# ClawLore Operator Runbook

Status: Phase 7 commercial release hardening baseline.

Use this runbook when preparing or validating a live
ClawLore rollout.

## Source Gate

Run from the plugin workspace:

```bash
npm test
npm run typecheck
npm run smoke:vector-repair
npm run build
node scripts/golden-benchmark.mjs
npm run release:gate:source
```

Do not continue to live rollout until all source gates pass and an independent
audit approves the exact candidate commit.

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
whether to repair or roll back.

## Rollback

Rollback restores the legacy extension and configuration backup as one unit,
then re-runs plugin inspect, doctor, dashboard, health, and a read-only recall
probe. Do not delete the backups until the replacement has passed live smoke.
