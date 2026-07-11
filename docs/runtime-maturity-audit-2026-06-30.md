# Runtime Maturity Audit - 2026-06-30

This audit records the Phase 0 baseline for the commercial memory plugin plan.
It corrects the 1.0.26 line to a partial OpenClaw-native adoption baseline, not
full Yuheng/Hermes 1.6.0 parity.

## Source Baseline

- Package: `scope-recall-openclaw`
- Source version: `1.0.26`
- Plan: `docs/commercial-memory-plugin-plan-2026-06-30.md`
- Decision: keep `1.0.26` as the partial-parity internal baseline. The next
  contract-driven commercial-memory work should move on the `1.1.0` line.

## Baseline Verification

Run from `/home/a/openclaw-tianji/home/state/workspace/scope-recall-openclaw`.

- `npm run release:gate`: passed.
- Test count inside release gate: 63 passed, 0 failed.
- Included checks: `npm test`, `npm run typecheck`,
  `npm run smoke:vector-repair`, `npm run build`,
  `node scripts/golden-benchmark.mjs`, workspace/live drift checks, and
  `npm pack --dry-run`.
- Golden benchmark result: `scope-recall-openclaw-golden-recall-v1` returned
  `ok: true`.

## Live Extension Snapshot

Command used:

```bash
OPENCLAW_STATE_DIR=/home/a/openclaw-tianji/home/state \
OPENCLAW_CONFIG_PATH=/home/a/openclaw-tianji/home/state/openclaw.json \
/home/a/openclaw-tianji/app/node_modules/.bin/openclaw plugins inspect scope-recall-openclaw
```

Observed result:

- Status: `loaded`
- Format: `openclaw`
- Source: `~/state/extensions/scope-recall-openclaw/dist/index.js`
- Origin: `config`
- Version: `1.0.26`
- Commands: `scope-recall`, `memory-pro`
- Policy: `allowConversationAccess: true`

The CLI also reported unrelated OpenClaw config warnings for uninstalled
`qianfan` and `deepseek` provider plugin entries, plus existing shared-state
plugin index migration warnings for `brave` and `discord`.

## Live Doctor Snapshot

Command used:

```bash
OPENCLAW_STATE_DIR=/home/a/openclaw-tianji/home/state \
OPENCLAW_CONFIG_PATH=/home/a/openclaw-tianji/home/state/openclaw.json \
/home/a/openclaw-tianji/app/node_modules/.bin/openclaw scope-recall doctor --json --quiet
```

Observed result:

- `ok: false`
- SQL truth: available, 816 rows
- FTS: 816 truth rows, 816 FTS rows, healthy
- Vector backend: LanceDB, configured dimension 3072
- Vector drift: 816 SQL truth rows, 815 vector rows, 1 missing vector row,
  0 stale vector rows
- Scope counts: SQL `agent:main` 816, vector `agent:main` 815
- Experience Kernel: enabled and ready
- Nightly digest ledger: enabled and ready, 35 successful runs

This is a live data drift issue. It does not invalidate the source release
gate, but live health is not fully green until vector repair is run and
rechecked.

## Live Dashboard Snapshot

Command used:

```bash
OPENCLAW_STATE_DIR=/home/a/openclaw-tianji/home/state \
OPENCLAW_CONFIG_PATH=/home/a/openclaw-tianji/home/state/openclaw.json \
/home/a/openclaw-tianji/app/node_modules/.bin/openclaw scope-recall dashboard --json
```

Observed result:

- `ok: true`
- Version: `1.0.26`
- Memory rows: 816
- FTS status: `ok`
- Governance cleanup candidates: 0
- Journal recovery: `unsupported`
- Memory candidate debt: 0
- Graph hygiene: `unsupported`
- Experience status: `ready`

The dashboard does not currently expose the doctor vector-row mismatch as a
top-level degraded state. That gap belongs in the commercial operator-health
work.

## Remaining Phase 0 Gaps

- The 1.0.26 line must stay described as partial adoption, not full parity.
- Commercial-grade claims remain blocked by the plan gaps: contract matrix,
  scope isolation proof, Recall Funnel, fact freshness, relation-aware recall,
  productized digest, Experience quality gates, package scans, and live rollout
  evidence.

## Phase 0 Vector Repair Follow-Up

The live vector drift was repaired after the baseline snapshot.

- SQL truth backup:
  `workspace/archive/scope-recall-openclaw-phase0-vector-repair-20260630_0320/memory-before-vector-repair.sqlite3`
- Dry-run command:
  `openclaw scope-recall repair-vectors --dry-run --json`
- Dry-run result: 816 SQL truth rows, 815 vector rows before repair,
  816 rows would be processed/rebuilt, 0 skipped, 0 errors.
- Apply command:
  `openclaw scope-recall repair-vectors --apply --json`
- Apply result: 816 SQL truth rows, 815 vector rows before repair,
  816 processed, 0 skipped, 0 errors.
- Post-repair doctor: `ok: true`, 816 SQL truth rows, 816 vector rows,
  0 missing vector rows, 0 stale vector rows, SQL/vector scope distributions
  matched.

The apply command returned `rebuilt: 25856`, which was not a real row count.
During the audit, a source bug was found: the repair result added the batch
length once for every rebuilt row. This audit corrected `src/store.ts` so
`rebuilt` increments once per row and changed the vector-repair smoke test to
use a multi-row batch, preventing this inflated count from recurring.

Operational gap found during the repair: the current apply path rebuilds all
SQL truth rows and performs per-row delete/add companion writes, so a small
one-row vector drift took about 30 minutes to repair. Future commercial
hardening should add a narrow missing/stale repair mode, progress output, and
more efficient companion writes.
