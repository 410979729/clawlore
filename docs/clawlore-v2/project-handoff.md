# ClawLore 2.0 project handoff

Current through Phase 8F-A on 2026-07-13.

## Live position

- OpenClaw runtime: shadow registration, hooks=1, writes=false,
  promptMutation=false, contextEngine=false, blocks=none.
- Gateway: active/running; healthz live.
- Live truth: V1/V2/current FTS/vector 1001/1001/1001/1001;
  candidate 664, active 0, archived 337, pending outbox 0.
- Current policy: 0 eligible / 508 hold / 156 quarantine.
- Current content review: 131 unsafe / 2 safe duplicate / 56 semantic review;
  mutation-ready 0.

## Latest completed phase

Phase 8F-A first converged the exact 15-row nightly V1 append under a fresh
restore-verified encrypted snapshot. It then rebuilt all candidate controls and
adjudicated the exact 131-row unsafe lane query-only: 99 soft-archive proposals,
32 bounded-rewrite holds, and 0 mutation-ready rows. No archive, rewrite,
verification, lifecycle, hard delete, or runtime change was performed.

- code commit: `da25aba`;
- full tests: 236/236 PASS;
- release package scan: 504 files;
- run report:
  `eval/phase8f-a-unsafe-trace-adjudication-run-2026-07-13.md`;
- owner-only rollback/audit evidence:
  `archive/clawlore-phase8f-unsafe-disposition-20260713_2316/`.

## Remaining controlled route

1. Phase 8F-B: verify/apply any selected 99-row reversible soft archive and
   create bounded rewrite proposals for the 32 holds under separate exact
   controls and fresh snapshots.
2. Phase 8G: adjudicate 2 safe duplicates and 56 semantic-review rows.
3. Phase 9: make an explicit lifecycle/final-recall cutover or no-cutover
   decision.

No completed phase authorizes automatic rejection, content rewrite, further
archive, verification, lifecycle promotion, ContextEngine, prompt mutation, or
final recall outside its exact target set. Re-read live state, take a fresh
encrypted snapshot before any mutation, and regenerate stale candidate/quality
plans after every lifecycle change.
