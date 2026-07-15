# Phase 7D approved additive live V2 write rollout — 2026-07-12

## Authorization and boundary

Joy explicitly approved rollout `clawlore-v2-write-20260712-r1` in the verified
Telegram private conversation. The 0600 approval control binds the rollout id,
implementation commit, V1 fallback requirement, and explicit denial of both
ContextEngine and final recall cutover.

This phase authorizes additive schema and migration writes only. The live
runtime remains in read-only shadow mode and continues to read through V1.

## Implementation

Implementation commit: `5b0a8d0`.

The new operator-plane executor validates private readiness and approval files,
rechecks the live V1 logical digest and migration-plan digest, requires a fully
healthy V1 vector fallback, rejects pre-existing V2 rollout tables, and applies
all DDL/data/projection receipts in one `BEGIN IMMEDIATE` transaction. A failure
rolls back the complete transaction instead of leaving partial schema or rows.

The transaction creates Truth V2, FTS, V1-vector fallback bindings,
relation-projection receipts, the rollout ledger, and five Experience tables.
It does not delete, rename, or rewrite a V1 table.

## Live result

- V1 SQL truth: 952 rows, unchanged logical digest.
- V1 FTS: 952 rows, healthy.
- V1 vector companion: 952 rows, missing/stale 0, scope distribution matched.
- V2 truth: 952 rows — active 0, candidate 632, archived 320.
- V2 FTS: 952 rows.
- V2 vector fallback bindings: 952 verified rows.
- V2 relation projection: 952 adjudicated no-source receipts; materialized
  relation edges remain 0 because legacy truth contains no relation source.
- Projection outbox: FTS 952, vector 952, relations 952 processed; pending 0.
- Experience: five tables present, rows 0.
- SQLite integrity: `ok`; foreign-key violations: 0.

## Runtime and service boundary

- `clawloreV2.mode` remains `shadow`.
- ContextEngine remains `compatibility`; no native ContextEngine registration.
- Final recall cutover remains disabled.
- Existing shadow readiness/approval pointers are unchanged.
- Gateway stayed active/running with restart count 0; healthz remained live and
  port 19021 listened throughout.
- Warning-or-higher unit logs for the rollout window were empty.

## Verification

- Focused live-rollout tests: 2/2 PASS.
- Full tests: 164/164 PASS.
- Typecheck, build, module boundaries, vector smoke, golden recall, and release
  gate: PASS.
- Golden recall: 1.0; forbidden violations 0; prompt-budget overruns 0.
- Pre-apply package scan: 355 files.
- Independent post-apply SQLite count/integrity check: PASS.
- Post-apply V1 doctor: PASS with SQL/FTS/vector all at 952 and issues empty.

## Retained evidence

All control and receipt files are owner-only under:

`workspace/archive/clawlore-phase7-encrypted-snapshot-20260712/`

The encrypted pre-write snapshot is retained for rollback. No plaintext
snapshot, decrypted database, WAL/SHM copy, or temporary doctor output remains.
Generated `node_modules` was removed and the candidate repository is clean.
The state-hygiene audit still reports the same 68 unrelated historical
outside-workspace findings; this rollout created none of them and did not
modify them.

## Next gate

Do not enable ContextEngine or switch final recall to V2 without a later,
separate rollout readiness receipt and explicit operator approval.
