# ClawLore 2.0 project handoff

Current through Phase 8F-B3A on 2026-07-14.

## Live position

- OpenClaw runtime: shadow registration, hooks=1, writes=false,
  promptMutation=false, contextEngine=false, blocks=none.
- Gateway: active/running, PID 328735, NRestarts 1; healthz live.
- Live truth has advanced to V1 1005 while V2/current FTS/vector/relation remain
  1003; candidate 567, active 0, archived 436, pending outbox 0. Integrity is ok
  and foreign-key violations are 0.
- The last rebuilt policy/content controls remain valid only for the 1003/1003
  Phase 8F-B2 postcheck. They are navigation evidence, not current write
  authority, until the exact two-row append is converged and controls rebuilt.

## Latest completed phase

Phase 8F-B3A added a non-mutating payload proposal and independent acceptance
layer for the exact 32 rewrite holds. The owner-only payload may carry proposed
prose; the public plan contains only hashes, lengths, evidence digests, counts,
and review metadata. The control fixes the lane at 7 oversized rows with one to
four outputs and 25 semantic rows with exactly one output. Capture-unsafe,
colliding, duplicate, incomplete, stale, or content-leaking proposals fail
closed, and every plan remains mutation-ready 0.

Read-only live inspection found a new two-row V1-only append: V1 1005 versus V2
and all four V2 projections at 1003. The new planner correctly refuses this
unconverged source. No private rewrite payload was created, no live memory body
was read or changed, and no snapshot or transaction was opened.

- full tests: 247/247 PASS;
- focused B1/B2/durable/B3A: 18/18 PASS;
- release package scan: 529 files;
- code commit: `365a7c0`;
- run report:
  `eval/phase8f-b3a-unsafe-trace-rewrite-proposal-controls-run-2026-07-14.md`.

## Remaining controlled route

1. Phase 8F-B3B: converge only the two new V1 rows under a fresh encrypted
   snapshot, rebuild controls, then create/accept the owner-only payload and
   separately design/apply exact materialization for the 32 holds. Do not reuse
   archive authority.
2. Phase 8G: adjudicate 2 safe duplicates and 56 semantic-review rows.
3. Phase 9: make an explicit lifecycle/final-recall cutover or no-cutover
   decision.

No completed phase authorizes automatic rejection, content rewrite, further
archive, verification, lifecycle promotion, ContextEngine, prompt mutation, or
final recall outside its exact target set. Re-read live state, take a fresh
encrypted snapshot before any mutation, and regenerate stale candidate/quality
plans after every append or lifecycle change.
