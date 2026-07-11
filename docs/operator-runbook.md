# Scope Recall Operator Runbook

Status: Phase 7 commercial release hardening baseline.

Use this runbook when preparing or validating a live
`scope-recall-openclaw` rollout.

## Source Gate

Run from the plugin workspace:

```bash
npm test
npm run typecheck
npm run smoke:vector-repair
npm run build
node scripts/golden-benchmark.mjs
npm run release:gate
```

Do not continue to live rollout until all source gates pass.

## Live Rollout

1. Record the current package version and live extension path.
2. Back up the live extension directory to a dated archive.
3. Sync the source package to the live extension.
4. Run `npm install` in the live extension only when dependencies changed.
5. Re-run `npm run release:gate` from the workspace so workspace/live drift is
   checked after sync.

## Live Smoke

Use the current OpenClaw home:

```bash
OPENCLAW_HOME=/home/a/openclaw-tianji/home/state \
  node /home/a/openclaw-tianji/app/node_modules/openclaw/openclaw.mjs \
  plugins inspect scope-recall-openclaw --json

OPENCLAW_HOME=/home/a/openclaw-tianji/home/state \
  node /home/a/openclaw-tianji/app/node_modules/openclaw/openclaw.mjs \
  scope-recall doctor --json --quiet

OPENCLAW_HOME=/home/a/openclaw-tianji/home/state \
  node /home/a/openclaw-tianji/app/node_modules/openclaw/openclaw.mjs \
  scope-recall dashboard --json

OPENCLAW_HOME=/home/a/openclaw-tianji/home/state \
  node /home/a/openclaw-tianji/app/node_modules/openclaw/openclaw.mjs \
  scope-recall digest report --json

OPENCLAW_HOME=/home/a/openclaw-tianji/home/state \
  node /home/a/openclaw-tianji/app/node_modules/openclaw/openclaw.mjs \
  scope-recall experience stats --json
```

Safe recall probes should use a non-secret query and must not force memory
writes. If doctor is degraded, record the exact degraded field before deciding
whether to repair or roll back.

## Rollback

Rollback is restoring the dated live extension backup, then re-running plugin
inspect, doctor, and dashboard. Do not delete the backup until the replacement
has passed live smoke.
