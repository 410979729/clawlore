# Phase 7P append-only V1 delta approval drift — 2026-07-12

## Position and authorization result

This round remains in migration stages 4–6. Joy approved rollout
`clawlore-v2-v1-delta-migration-20260712-r1` only for the exact Phase 7O
27-row plan digest
`28957730237f1b4a272cd1a103c1114db30411f153e6bc21fd01aa49afd0ac1a`.
The approval explicitly required a read-only replan and prohibited writes if
the delta set or digest drifted.

The live pre-apply plan did drift. V1 grew from 979 to 980 while V2 remained
952, so the delta became 28 rows and the digest became
`6f1e6ac9764dc3e2e5fd7796075a360696ae484f7b308b6d1fa2cfa59b421d35`.
The new classification is 27 `reflection_summary` rows plus 1
`operational_checkpoint`; all 28 remain `candidate`, `unverified`, carry
`legacy_identity` debt, and require review.

The old approval was rejected before snapshot creation or database mutation.
No approval control was synthesized for the new digest. No encrypted snapshot,
Truth row, projection row, outbox row, lifecycle change, configuration change,
or service restart occurred.

## Bounded implementation bundle

Commit `53b499e` adds the previously missing exact-delta apply path without using
it against live data:

- owner-only plan, approval, fresh encrypted snapshot, rollout id, and exact
  plan digest must all match before a write transaction can begin;
- the current live plan is recomputed and the complete delta/source/projection
  contract must equal the approved plan;
- every inserted row is forced to candidate/unverified with legacy-identity
  debt and review required;
- existing canonical rows, revisions, source evidence, ACLs, events, lifecycle,
  and verification are digest-protected;
- Truth, compatibility FTS, current FTS, vector fallback, relation projection,
  and three processed outbox receipts per row are inserted atomically;
- V1 fallback stays enabled and existing candidate lifecycle, ContextEngine,
  prompt mutation, and final recall remain disabled.

Three apply regressions cover a successful fixture transaction, plan drift
before mutation, and rejection of an over-broad lifecycle approval. Together
with the three existing planner regressions, the focused bundle is 6/6 PASS.

## Verification

- full tests: 192/192 PASS;
- typecheck and build: PASS;
- module boundaries, ranking/promotion controls, Phase 7G controls, vector
  repair, golden recall, and release gate: PASS;
- golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0;
- release package scan: 414 files.

Live exit remains read-only:

- V1/V2: 980/952;
- lifecycle: 0 active / 632 candidate / 320 archived;
- compatibility/current FTS/vector/relation projections: 952 each;
- pending outbox: 0;
- SQLite integrity: `ok`; foreign-key violations: 0;
- Gateway: active/running, MainPID 4169210, `NRestarts=0`, healthz live, and no
  warning-or-higher unit entries during the round.

The fresh owner-only read-only receipt is:

`workspace/archive/clawlore-phase7p-v1-delta-20260712_235203/v1-append-delta-preview-fresh-20260712.json`

It is mode 0600. No snapshot or approval artifact exists in that directory.

## Exit boundary

The 28-row plan is a new approval subject. The Phase 7O 27-row approval cannot
be reused or widened. Any later write requires a fresh encrypted snapshot and
a new exact approval bound to the 28-row digest and both classifications.
ContextEngine, prompt mutation, lifecycle promotion, and final recall remain
outside scope.
