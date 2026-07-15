# Phase 7G rollout control isolation run — 2026-07-12

## Scope

This round added executable control contracts for the two independent actions
left after Phase 7F: compatibility FTS backfill and candidate lifecycle
promotion. It did not create a live compatibility projection, review or
promote the 632 live candidates, change runtime configuration, mutate prompts,
select ContextEngine, cut over final recall, or restart the Gateway.

## Implementation

- Added a snapshot-bound Phase 7G control bundle with a one-hour default
  freshness gate, verified-restore requirement, source-stability requirement,
  and plaintext-residue rejection.
- Bound compatibility projection evidence to exact V1/V2 row parity, zero
  mapping mismatches, an absent destination projection, and the exact ordered
  eight-field legacy search allowlist.
- Bound the promotion plan to the exact candidate-row count and rejected plans
  that include archived rows or cover only part of the current candidate set.
- Required distinct rollout ids, modes, and plan digests for compatibility
  backfill and candidate promotion. A valid approval for one action fails when
  presented to the other action.
- Kept both actions non-authorizing in the control receipt. ContextEngine,
  prompt mutation, and final recall are explicitly false regardless of plan
  readiness.
- Added three focused tests and one machine-readable fixture smoke.
- Implementation commit: `7279501`.

## Verification

- Focused Phase 7F + 7G tests: 6/6 PASS.
- Full plugin tests: 172/172 PASS.
- Typecheck and build: PASS.
- Module-boundary tests: 2/2 PASS.
- Vector-repair smoke: PASS.
- Golden recall: recall 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Release gate: PASS; package scan 373 files.
- The first typecheck attempt did not run because the environment had omitted
  devDependencies and `tsc` was absent. Development dependencies were then
  installed and the real typecheck/build/full gates passed.

## Live read-only exit evidence

- Gateway: active/running, `NRestarts=0`; port 19021 healthz returned live.
- Warning-or-higher service journal for the round: empty.
- SQLite integrity: ok; foreign-key violations: 0.
- V1/V2 rows: 952/952; V2 lifecycle: 0 active, 632 candidate, 320 archived.
- V1 FTS, V2 FTS, vector fallback, and relation projection: 952 each.
- Projection outbox pending: 0.
- `memory_fts_compat_v2` objects: 0.

All database checks used a read-only `query_only` transaction. No live data,
plugin source, configuration, runtime registration, prompt, ContextEngine, or
service process changed.

## Decision and remaining gates

The control contract is fixture-verified, but no live Phase 7G plan or action
is authorized. The next permitted step requires an exact preview authorization
to create a fresh encrypted snapshot and generate two read-only live plans.
After those plans exist, compatibility backfill and candidate promotion still
require their own separate exact-digest operator approvals. Final recall,
prompt mutation, and ContextEngine remain later independent gates.

## Cleanup

Generated dependencies are removed after the documentation commit and final
verification. No temporary receipt, snapshot, database, or live projection was
created in this round. Existing encrypted rollback evidence remains retained.
Workspace layout is clean. State hygiene still reports the same 68 historical
outside-workspace findings; none was created or modified by Phase 7G.
