# Phase 8A duplicate-trace adjudication — 2026-07-13

## Scope and outcome

Phase 8A adjudicates only the 20 exact-duplicate operational-trace rows isolated
by Phase 7Z. It does not adjudicate the remaining 131 unsafe rows, the 2 safe
duplicate rows, or the 53 manual-semantic rows. It proposes future reversible
soft archive for 14 rows in 5 groups and holds 6 rows in 3 groups for bounded
rewrite because those rows contain durable design facts.

The plan is query-only and non-authorizing. All 20 rows remain
candidate/unverified, mutation-ready remains 0, and no rewrite, archive,
verification, lifecycle, ContextEngine, prompt, or final-recall action occurred.

## Truth deduplication and implementation

The eight normalized duplicate groups were reviewed against the durable
knowledge layer before assigning a disposition:

- five groups / 14 rows are already covered by durable operational knowledge
  or are transient service-status traces, so they may enter a future exact
  soft-archive plan;
- three groups / 6 rows contain durable architecture facts about the local
  collaboration control plane, the memory-to-capability gap, and
  episode-before-reviewer ordering, so they remain held for bounded rewrite.

Commit `6181f23` adds:

- a pure adjudication policy that requires complete, one-to-one decisions for
  every exact duplicate group and rejects unsafe disposition bases;
- an owner-only live planner that revalidates the Phase 7Z plan, decision
  control, and every protected current row;
- a narrow append-only tolerance: a query-only plan may cross unrelated source
  growth only when V1, V2, candidate count, and all four projections advance by
  the same amount while active, archived, and pending-outbox counts stay fixed;
- a mode-0600 redacted CLI output and regression tests for decision drift,
  current-row drift, raw-content exclusion, and append-only convergence.

The append-only tolerance does not authorize mutation and cannot absorb a new
row into the protected target set.

## Live convergence before adjudication

Live preflight found one new V1 operational checkpoint: V1/V2 were 984/983.
Planning stopped before adjudication. A fresh encrypted snapshot then
restore-verified all 984 V1 rows:

- logical digest:
  `a17b79616a083f62d0f9c95b93b44f6b2c12369b22ce1bea08e31ef5ec47e852`;
- encrypted archive SHA-256:
  `e445c5aab2f5e6778ce0450003f00e2310a9aec90de397409df7623857a3d145`.

The exact r6 delta plan digest
`92db32435b9f7174971d0b8902233e71011a70af188583551f64a8a9b3dc02d4`
then appended only that checkpoint as candidate/unverified. Existing canonical,
lifecycle, verification, and evidence changes were 0. V1/V2 and compatibility,
current FTS, vector, and relation projections converged at 984; candidate became
664, active stayed 0, archived stayed 320, pending outbox stayed 0, integrity was
`ok`, and foreign-key violations were 0.

## Live query-only adjudication plan

Owner-only controls are retained under
`workspace/archive/clawlore-phase8a-duplicate-trace-adjudication-20260713_1740/`.

- decision-control digest:
  `3027e14e4dee33309e261b438d753189b342cfa96b49b7820befb7f10a679cab`;
- decision-control file SHA-256:
  `62f53afb813509c63d98f294980e24de6e01d78a60132b5bc902eed5b99fb612`;
- adjudication-plan digest:
  `0e5055c67af898aa1db4d08648b0962cdaba8c4cd1f88530e2491d1b2e88c5b4`;
- adjudication-plan file SHA-256:
  `fdbc0915c5ece9d09efcd133ba84a1019ec58ae2d680ef3e362cb956b47e3792`;
- protected targets: 8 groups / 20 rows; live mismatches: 0;
- future soft-archive proposal: 5 groups / 14 rows;
- bounded-rewrite hold: 3 groups / 6 rows;
- raw content or raw identifier leakage: 0;
- automatic archive, content rewrite, lifecycle mutation, and mutation-ready
  rows: 0.

The plan records one fully converged append-only source extension relative to
the Phase 7Z control. It does not include that checkpoint in the 20 protected
targets and explicitly requires a separate exact apply for every later action.

## Verification and runtime boundary

- focused Phase 7Y/7Z/8A tests: 11/11 PASS;
- full suite: 216/216 PASS;
- typecheck, build, module-boundary, runtime-composition, ranking, Phase 7G
  control, vector-repair, golden-recall, and release gates: PASS;
- golden recall: 1.0, forbidden violations 0;
- closing package scan: 451 files;
- scope-recall doctor: `ok=true`, issues 0, SQL/FTS/vector 984/984/984;
- Gateway: `active/running`, MainPID 328735, NRestarts 1, healthz live, and no
  journal entries during the Phase 8A acceptance window.

The first local typecheck attempt lacked development dependencies because the
environment installed production dependencies only; explicitly installing dev
dependencies resolved it. A manual `benchmark:golden` script name was also
incorrect; the real `node scripts/golden-benchmark.mjs` command and the release
gate both passed. Neither command error changed source or live memory.

## Cleanup and next boundary

The encrypted snapshot and minimal owner-only controls are retained for
rollback and audit. Development dependencies and any plaintext restore,
WAL/SHM, lock, or temporary log residue are removed before close.

The next safe work is either:

1. produce bounded rewrites for the 6 durable rows and deduplicate their facts
   against knowledge; or
2. create a fresh-snapshot, exact 14-row soft-archive apply with independent
   acceptance.

The other 131 unsafe rows remain entirely outside this phase and require their
own lane-specific decisions.
