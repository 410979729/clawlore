# Phase 7Y candidate content-quality review plan — 2026-07-13

## Scope and outcome

Phase 7Y adds a bounded, query-only content-quality review planner for the 206
Phase 7X source-lineage candidates. It reuses the existing capture-safety
policy, binds every row to its item/revision/content/normalized-content/lineage
digests, detects exact normalized duplicates and the existing 4,000-character
admission boundary, and emits no memory text, transcript text, or raw ids.

This is structural triage, not semantic approval. Every row remains
candidate/unverified. The plan authorizes no rewrite, archive, delete,
lifecycle/verification mutation, ContextEngine, prompt mutation, or final
recall.

## Implementation

Commit `4113e88` adds:

- a pure content-quality assessment policy that reuses `capture-safety`;
- shared structural validation for `sourceLineageReceiptV1`;
- an owner-only live planner bound to the exact Phase 7X remediation digest and
  live V1/V2/projection counts;
- a CLI that writes one mode-0600 redacted plan;
- regressions for normal quality partitioning, invalid lineage receipts, V1/V2
  drift, and live control-object field-order differences.

The first live attempt failed closed before creating a receipt. Direct SQL
verification showed no drift: V1/V2 and all projections were still 983. The
root cause was semantic state equality implemented with ordinary
`JSON.stringify`, while the same fields had different insertion order in the
live control file. The planner now compares typed fields explicitly; the live
field order is preserved in a regression fixture.

## Live query-only plan

The owner-only plan is retained at
`workspace/archive/clawlore-phase7y-content-quality-review-20260713_163746/candidate-content-quality-review-r1-20260713.json`.

- file SHA-256:
  `24b84e5b39574059aeb47685c390a6dfb24a432bc71e1b8857ce55d39018622e`;
- plan digest:
  `d8e1a10e3e73d242bfba84409e14327858c4bf036213da5860666c9dc1c4250b`;
- Phase 7X remediation digest:
  `fb448f51ffb11a4ae4a9f96ac2c9ba47828de08af3e4147faae4754938b92a53`;
- exact targets: 206; mutation-ready: 0.

Structural findings:

- 151 capture-safety rejects, all operational traces:
  134 `command-hints-block` and 17 `tool-fields-block`;
- 55 structurally reviewable rows;
- 22 rows in 9 exact normalized duplicate groups; 20 are already inside the
  unsafe group, while 2 safe rows enter exact-duplicate review;
- 10 rows over 4,000 characters; all 10 are already inside the unsafe group;
- 53 safe, unique, within-limit rows enter manual semantic review;
- categories: 155 fact / 46 decision / 3 preference / 2 entity.

Primary review lanes are therefore 151 capture-safety reject review / 0 safe
oversized review / 2 safe exact-duplicate review / 53 manual semantic review.
Independent acceptance matched all 206 item, revision, raw-content,
normalized-content, and lineage-receipt digests; it found no raw memory content
or raw item/revision id in the serialized plan.

## Live state and boundary

Before and after planning:

- V1/V2 and compatibility/current FTS/vector/relation: 983 each;
- candidate 663 / active 0 / archived 320;
- pending outbox 0, integrity `ok`, foreign-key violations 0;
- source-lineage receipts on all 206 targets;
- live memory, lifecycle, verification, address, projections, config, runtime
  composition, and Gateway state unchanged.

The next safe stage is separate operator adjudication: inspect the 151 unsafe
rows for reversible rejection/archival decisions, choose a canonical row for
the safe duplicate group, and manually assess factual accuracy, durability,
and scope for the 53 clean rows. No result from this query-only plan may be
treated as automatic promotion authority.

## Verification

- focused content/remediation tests: 7/7 PASS;
- full suite: 208/208 PASS;
- typecheck, build, vector repair, golden recall, runtime inspect/doctor, and
  release gate: PASS;
- closing package scan: 438 files.
