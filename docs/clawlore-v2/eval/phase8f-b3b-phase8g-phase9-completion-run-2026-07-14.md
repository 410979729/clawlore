# ClawLore Phase 8F-B3B / 8G / 9 completion run — 2026-07-14

## Outcome

The remaining ClawLore v2 roadmap is closed through an explicit Phase 9
`no_cutover` decision.

- Phase 8F-B3B converged the exact two-row V1 append, rebuilt controls, created
  and independently accepted a private 32-row rewrite payload, applied exactly
  32 bounded current-content rewrites, and independently postchecked the live
  transaction.
- Phase 8G reviewed the exact post-rewrite remainder: 2 safe duplicates and 56
  semantic-review candidates. It produced 24 reversible soft-archive proposals
  and retained 34 durable candidates for later verification. No rewrite hold
  remains and the plan authorizes no mutation.
- Phase 9 made an explicit `no_cutover` decision from current live evidence.
  V1 fallback and the read-only shadow remain in place; ContextEngine, prompt
  mutation, lifecycle promotion, and final recall remain disabled.

No private memory prose, raw item/revision identifier, credential, or source
trace is included in this report. Private payload and decision evidence remain
owner-only in the task archive.

## Phase 8F-B3B live convergence

The first fresh restore-verified encrypted snapshot bound the live 1005/1003
source. Exact append plan `r12` migrated only the two new V1 rows as
candidate/unverified legacy-identity debt.

Post-r12 state:

- V1 / V2 / compatibility FTS / current FTS / vector / relation: 1005 each;
- candidate / active / archived: 569 / 0 / 436;
- pending projection outbox: 0;
- SQLite integrity: `ok`; foreign-key violations: 0.

All candidate, evidence, content-quality, capture-safety, unsafe-adjudication,
and disposition controls were regenerated from that converged source before
the rewrite proposal was accepted.

The accepted owner-only payload contains exactly one final bounded synthesis
for each of the 32 targets. This is intentionally stricter than the B3A design,
which permitted up to four possible outputs for the seven oversized design
rows: live materialization does not create child-item identity implicitly.

A second fresh restore-verified encrypted snapshot then bound the exact rewrite
transaction. The apply created:

- 32 new current revisions;
- 32 superseded prior revisions;
- 32 new source records;
- 32 supersedes relations;
- 32 correction events;
- 32 updated current-FTS rows.

The transaction changed current content for exactly 32 targets and changed
lifecycle, verification, address, ACL, compatibility/vector/relation
projections, outbox, non-target rows, and runtime gates by zero. V1 remained
unchanged.

Independent postcheck proved 32 rewritten candidate/unverified rows, 32 valid
rewrite receipts, 32 superseded revisions, 32 supersedes relations, 32 events,
32 current-FTS bindings, preserved compatibility/vector/relation projections,
and zero mismatches. Integrity remained `ok` with zero foreign-key violations.

## Phase 8G exact adjudication

The generic post-rewrite content-quality pass correctly found zero remaining
capture-unsafe rows, but it initially placed the 32 safely rewritten rows in
the manual-semantic lane because the generic classifier does not carry rewrite
receipt state. A new receipt-aware adjudication boundary now validates the
complete proposal/apply/postcheck chain, the current safe content digests, and
all 32 rewrite receipts before closing those rows from semantic review.

The exact remaining review set is:

- 2 safe exact-duplicate rows;
- 56 manual semantic-review rows;
- 0 capture-unsafe rows;
- 0 oversized safe rows;
- 0 mutation-ready rows.

Authenticated private operator review covered all 58 rows. The redacted result
is:

- 24 `propose_soft_archive` rows: transient conversation fragments, policy
  material already covered by canonical controls, one volatile runtime
  snapshot, and one semantically redundant row;
- 34 `retain_candidate_for_verification` rows: durable facts, decisions, and
  preferences that still lack promotion-grade verification;
- 0 bounded-rewrite holds.

This Phase 8G plan is query-only. The 24 archive dispositions are proposals,
not an implicit lifecycle mutation; selecting them later requires a separate
fresh snapshot, exact apply allowlist, and independent postcheck.

## Phase 9 explicit decision

The Phase 9 receipt binds the current candidate baseline, Phase 8G plan,
rewrite postcheck, owner-only live configuration, and query-only database
inspection.

Decision: `no_cutover`.

Observed blockers:

1. no active verified/injectable V2 memory;
2. zero eligible candidate promotions;
3. candidate lifecycle rollout is not selectable;
4. candidate verification debt remains;
5. 24 Phase 8G soft-archive proposals are intentionally unapplied;
6. 47 current V1/V2 content differences exist, including controlled rewrite
   history and archived-row differences;
7. the deployed runtime implements only `disabled` / read-only `shadow`, not a
   cutover mode.

The decision preserves:

- configured mode `shadow`;
- compatibility ContextEngine selection;
- V1 fallback reads enabled;
- ContextEngine registration disabled;
- prompt mutation disabled;
- final recall cutover disabled;
- automatic promotion rows 0.

## Verification

- new focused Phase 8G/9 tests: 6/6 PASS;
- full plugin tests: 255/255 PASS;
- `npm run typecheck`: PASS;
- `npm run build`: PASS;
- module-boundary smoke: 2/2 PASS;
- runtime-composition smoke: PASS, one shadow observer, writes false, prompt
  mutation false, ContextEngine false;
- vector-repair smoke: PASS;
- golden recall: recall 1.0, top-K 1.0, forbidden violations 0, prompt-budget
  exceeded 0;
- release gate: PASS;
- release package scan: 547 files.
- live doctor: `ok=true`, issues 0, SQL/FTS/vector 1005/1005/1005;
- Gateway: active/running, PID 328735, NRestarts 1, port 19021 listening,
  `/healthz` live;
- recent phase-window ClawLore/Gateway error matches: 0.

Code commit: `96d9bfe`.

## Evidence and boundaries

Owner-only evidence directory:

`workspace/archive/clawlore-phase8f-b3b-unsafe-rewrite-20260714_1718/`

Key evidence includes the r12 plan/apply/acceptance, two encrypted snapshot
receipts, rewrite payload/plan/acceptance/apply/postcheck, Phase 8G operator
decision and adjudication controls, and the Phase 9 no-cutover receipt.

The run did not change `openclaw.json`, plugin deployment files, Gateway
service configuration, model routing, runtime shadow settings, or the active
ContextEngine/prompt/final-recall boundary. No Gateway restart was needed.
