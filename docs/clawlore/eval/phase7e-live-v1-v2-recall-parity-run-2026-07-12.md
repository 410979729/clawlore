# Phase 7E live V1/V2 recall parity run — 2026-07-12

## Scope

This round added a read-only live V1/V2 recall parity gate after the approved
additive V2 write rollout. It did not deploy candidate code, modify the live
database, change configuration, mutate prompts, register ContextEngine, switch
final recall, or restart the Gateway.

The gate intentionally separates two decisions:

- `shadowReadReady` means the V2 corpus can be queried beside V1 without
  changing runtime behavior.
- `cutoverReady` additionally requires active/verified injectable rows, policy
  evidence, and native ranking quality.

Neither decision authorizes a runtime change.

## Implementation

- Added `src/v2/eval/live-v1-v2-recall-parity.ts` with a query-only SQLite
  transaction, V1/V2 corpus checks, common-lane and native-FTS comparisons,
  strict V2 address/lifecycle/verification filtering, and redacted output.
- Added `scripts/clawlore-live-recall-parity.mjs`; its receipt is owner-only,
  contains hashes/counts rather than query or memory text, and uses `wx` to
  prevent evidence replacement.
- Added two focused regressions: stricter V2 policy excludes a legacy
  scope-visible private row, and a candidate-only corpus may pass shadow parity
  but can never pass cutover.
- Implementation commit: `9e9c2c5`.

## Live evidence

The 0600 receipt is:

`workspace/archive/clawlore-phase7-encrypted-snapshot-20260712/v1-v2-recall-parity-receipt-20260712.json`

Six fixed, non-sensitive queries were evaluated. The receipt emits only query,
scope-set, and result-id digests plus aggregate counts.

- Source remained unchanged in one read transaction.
- V1/V2 rows: 952/952; missing or duplicate mappings: 0.
- V1/V2 FTS rows: 952/952.
- V1-vector fallback mappings: 952; invalid mappings: 0.
- Category mismatches: 0.
- Thirteen rows differed only because the approved migration applies JavaScript
  `trim()`; total substantive content mismatches: 0.
- Common content/category lane: minimum Top-K overlap 1.0 and rank agreement
  1.0.
- Native FTS lane: minimum Top-K overlap 0.6. V1 searches text plus legacy
  metadata text while V2 searches canonical content plus category, so this
  remains a cutover-quality blocker rather than being hidden as parity.
- V2 forbidden-scope leakage: 0.
- V2 policy-eligible and injectable results: 0, consistent with 0 active, 632
  candidate, and 320 archived rows.

Decision: `shadowReadReady=true`, `cutoverReady=false`. Shadow blockers are
empty. Cutover blockers are `no_active_v2_memory`,
`no_injectable_v2_recall_evidence`, and
`native_ranking_overlap_below_0_8`. The receipt explicitly denies runtime,
ContextEngine, and final-recall authorization.

## Verification

- Focused parity tests: 2/2 PASS.
- Full plugin tests: 166/166 PASS.
- Typecheck and build: PASS.
- Module-boundary tests: 2/2 PASS.
- Vector-repair smoke: PASS.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Release gate: PASS; package scan 359 files.
- Exit live check: Gateway `active/running`, healthz `live`, port 19021
  listening, NRestarts 0, and warning-or-higher unit log empty for the round.

## Remaining gates

Do not cut over. The next safe development slice is a fixture-only ranking
diagnostic/compatibility design plus an evidence-backed candidate review and
promotion plan. Any live V2 mutation, dual-write activation, ContextEngine
registration, prompt mutation, or final-recall change needs a new explicit
operator gate.
