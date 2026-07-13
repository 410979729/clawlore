# ClawLore 2.0 project handoff

Current through Phase 8F-B2 on 2026-07-14.

## Live position

- OpenClaw runtime: shadow registration, hooks=1, writes=false,
  promptMutation=false, contextEngine=false, blocks=none.
- Gateway: active/running, PID 328735, NRestarts 1; healthz live.
- Live truth: V1/V2/current FTS/vector 1003/1003/1003/1003;
  candidate 567, active 0, archived 436, pending outbox 0.
- Current policy: 0 eligible / 411 hold / 156 quarantine.
- Current content review: 32 unsafe / 2 safe duplicate / 56 semantic review;
  mutation-ready 0.

## Latest completed phase

Phase 8F-B2 first refused a stale archive replay at V1/V2 1003/1002. A fresh
encrypted snapshot plus exact r11 converged only the new operational checkpoint
and restored all projections to 1003. After every control was rebuilt, a second
fresh encrypted snapshot and independent acceptance bound an exact 99-row
soft-archive transaction. The protected 32 rewrite targets and every non-target
surface remained unchanged.

The independent postcheck proved 99 archived targets, 99 valid receipts,
relations, lifecycle events, and projection bindings, 32 unchanged rewrite
targets, and 0 mismatches. The unsafe archive lane is now empty; all 32 remaining
unsafe rows require separate rewrite authority.

- code commit: `379f326`;
- full tests: 242/242 PASS;
- release package scan: 521 files;
- run report:
  `eval/phase8f-b2-unsafe-trace-archive-live-apply-run-2026-07-14.md`;
- owner-only rollback/audit evidence:
  `archive/clawlore-phase8f-b2-unsafe-archive-20260714_0114/`.

## Remaining controlled route

1. Phase 8F-B3: create payload-bearing proposals and separately controlled
   rewrites for the exact 32 holds; do not reuse archive authority.
2. Phase 8G: adjudicate 2 safe duplicates and 56 semantic-review rows.
3. Phase 9: make an explicit lifecycle/final-recall cutover or no-cutover
   decision.

No completed phase authorizes automatic rejection, content rewrite, further
archive, verification, lifecycle promotion, ContextEngine, prompt mutation, or
final recall outside its exact target set. Re-read live state, take a fresh
encrypted snapshot before any mutation, and regenerate stale candidate/quality
plans after every append or lifecycle change.
