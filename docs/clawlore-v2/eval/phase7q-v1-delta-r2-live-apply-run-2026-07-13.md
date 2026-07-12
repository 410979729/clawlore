# Phase 7Q V1 append-only delta r2 live apply — 2026-07-13

## Scope and exact authorization

Joy approved rollout `clawlore-v2-v1-delta-migration-20260712-r2`, bound to
plan digest
`6f1e6ac9764dc3e2e5fd7796075a360696ae484f7b308b6d1fa2cfa59b421d35`.
The approval covered exactly 27 append-only V1 reflection summaries and one
append-only V1 operational checkpoint. All 28 rows had to remain
candidate/unverified with legacy-identity debt. Existing V2 canonical state,
lifecycle, verification, and evidence were immutable; V1 fallback remained
enabled, while ContextEngine, prompt mutation, and final recall stayed disabled.

## Fail-closed pre-apply control

The first local preflight invocation supplied an incorrect workspace default
and produced a different address/plan digest. It was rejected before snapshot
or database mutation. Re-running with the exact Phase 7P planning parameters
reproduced the approved digest and yielded an exact hash match across baseline,
source, proposed rows, projection work, and decision controls.

The accepted pre-apply state was V1/V2 980/952 with 28 delta rows, zero missing
legacy backing, compatibility rows 952, pending outbox 0, and unchanged V1
logical digest. The two rejected parameter-check receipts were temporary and
were removed during exit cleanup.

## Fresh encrypted snapshot

A fresh AES-256-GCM snapshot was created before the write transaction. Restore
verification passed with 980 V1 rows, the exact approved logical digest,
SQLite integrity `ok`, zero foreign-key violations, and no retained plaintext
SQLite/WAL/SHM restore files. The archive and receipt are owner-only and remain
as rollback evidence. The persistent SecretRef was reused without copying key
material into the repository, report, or receipts.

## Live apply and independent acceptance

The exact-digest transaction appended 28 V2 rows:

- 27 `reflection_summary` and 1 `operational_checkpoint`;
- 28 candidate, 28 unverified, 28 legacy-identity debt;
- existing canonical/lifecycle/verification/evidence changes: 0;
- compatibility/current FTS/vector/relation projection rows: 980 each;
- new processed outbox rows: 84; pending outbox rows: 0.

Independent read-only SQL verification confirmed V1/V2 parity at 980/980,
lifecycle 0 active / 660 candidate / 320 archived, the exact rollout ledger
id/digest/row count, 27+1 source classifications, SQLite integrity `ok`, and
zero foreign-key violations. The live V1 doctor reported SQL truth 980, FTS
healthy, vector companion 980 with no missing/stale rows, and matching SQL/
vector scope counts.

## Regression and runtime verification

- focused delta plan/apply tests: 6/6 PASS;
- full plugin tests: 192/192 PASS;
- typecheck, build, module boundaries, ranking/promotion controls, Phase 7G
  rollout controls, vector repair, golden recall, and release gate: PASS;
- golden recall: 1.0 with zero forbidden violations and zero prompt-budget
  overruns;
- release package scan: 415 files.

The initial typecheck attempt found that the environment had omitted
devDependencies, so `tsc` was unavailable. Installing the declared development
dependencies resolved the environment issue; typecheck and build then passed.

Gateway remained active/running with unchanged MainPID 4169210,
`NRestarts=0`, healthz live, port 19021 listening, and no warning-or-higher unit
entries after apply. No configuration change or service restart occurred.

## Evidence and exit boundary

Owner-only controls and evidence are retained under:

`workspace/archive/clawlore-phase7q-v1-delta-r2-20260713_001212/`

The retained set is the exact pre-apply plan, approval, encrypted snapshot,
snapshot receipt, apply receipt, and independent acceptance receipt. V1
fallback remains active. The 28 new rows are not active and do not authorize
lifecycle promotion, ContextEngine, prompt mutation, or final recall. Any
candidate-policy re-evaluation must start from a new 660-candidate read-only
baseline and obtain separate approval for any later mutation.
