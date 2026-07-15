# Phase 7O append-only V1 delta migration preview — 2026-07-12

## Position and boundary

This round remains in migration stages 4–6. It plans the 27 V1 rows discovered
after Phase 7M/7N, but does not write V2, rebuild projections, change lifecycle,
or enable ContextEngine, prompt mutation, or final recall.

Implementation commit `1334383` adds an owner-only baseline-bound delta planner,
CLI, and three focused regressions. The planner reads the live V1/V2 mapping in
query-only mode, rejects missing legacy backing for existing V2 items, emits
only hashed ids/content/address plus classification decisions, and verifies the
V1 logical digest stayed stable during planning.

## Live plan

The owner-only receipt is:

`workspace/archive/clawlore-phase7o-v1-append-delta-plan-20260712_232138/v1-append-delta-preview-20260712.json`

It has mode 0600 and SHA-256
`07c4673202074e20bebfb7c961762ab54a4f38bf9b2c15ea456807b10b8ac146`.

Live source and classification:

- V1/V2: 979/952; delta rows: 27;
- missing legacy backing for existing V2: 0;
- compatibility rows: 952; pending outbox: 0;
- all 27 rows classify as `reflection_summary`;
- all 27 are `unverified`, carry `legacy_identity` debt, and require review;
- invalid metadata rows: 0;
- proposed lifecycle: 0 active / 27 candidate / 0 archived.

Legacy metadata labels these rows active, but unresolved identity and missing
verification take precedence. The preview therefore cannot turn them into
active or injectable memory.

Proposed delta plan digest:

`28957730237f1b4a272cd1a103c1114db30411f153e6bc21fd01aa49afd0ac1a`

Projection work for a later approved transaction is 27 Truth rows, 27
compatibility rows, 27 current FTS rows, 27 vector-fallback rows, 27 relation-
projection rows, and 81 processed outbox receipts. The preview itself sets
`authorizesDeltaWrite=false` and `finalRecallCutoverReady=false`.

## Verification

- focused delta-plan tests: 3/3;
- full tests: 189/189;
- typecheck, build, module boundaries, ranking/promotion, Phase 7G controls,
  vector repair, golden recall, and release gate: PASS;
- golden recall 1.0, forbidden violations 0, prompt-budget exceeded 0;
- release package scan: 409 files.

Live exit remains V1/V2 979/952, lifecycle 0 active / 632 candidate / 320
archived, compatibility 952, and pending outbox 0. SQLite integrity is `ok`
with zero foreign-key violations. Gateway stayed active/running with unchanged
MainPID 4169210, `NRestarts=0`, healthz live, and no warning-or-higher unit log
entries. No database, configuration, or service mutation occurred.

## Approval boundary

Any live delta apply requires a fresh encrypted snapshot and a separate
approval bound to rollout
`clawlore-v2-v1-delta-migration-20260712-r1` and the exact plan digest above.
The approval must preserve all existing V2 rows/lifecycle, V1 fallback,
ContextEngine, prompt mutation, and final recall boundaries.
