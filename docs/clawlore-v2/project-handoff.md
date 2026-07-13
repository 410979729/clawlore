# ClawLore 2.0 project handoff

Current through Phase 8E on 2026-07-13.

## Live position

- OpenClaw runtime: shadow registration, hooks=1, writes=false,
  promptMutation=false, contextEngine=false, blocks=none.
- Gateway: active/running; healthz live.
- Live truth: V1/V2/current FTS/vector 986/986/986/986;
  candidate 649, active 0, archived 337, pending outbox 0.
- Current policy: 0 eligible / 493 hold / 156 quarantine.
- Current content review: 131 unsafe / 2 safe duplicate / 56 semantic review;
  mutation-ready 0.

## Latest completed phase

Phase 8E soft-archived only the separately authorized 5-group / 14-row
reversible duplicate lane. It used an exact plan, two fresh restore-verified
encrypted snapshots, a target allowlist, and an independent postcheck. Content,
verification, address, ACL, V1, projections, outbox, non-target rows, and all
runtime gates changed by 0.

- code commit: `8e0ed3c`;
- full tests: 233/233 PASS;
- release package scan: 492 files;
- run report:
  `eval/phase8e-duplicate-disposition-live-apply-run-2026-07-13.md`;
- owner-only rollback/audit evidence:
  `archive/clawlore-phase8e-duplicate-disposition-20260713_215037/`.

## Remaining controlled route

1. Phase 8F: adjudicate 7 unique oversized, 109 command, and 15 tool-payload
   unsafe rows under separate exact controls.
2. Phase 8G: adjudicate 2 safe duplicates and 56 semantic-review rows.
3. Phase 9: make an explicit lifecycle/final-recall cutover or no-cutover
   decision.

No completed phase authorizes automatic rejection, content rewrite, further
archive, verification, lifecycle promotion, ContextEngine, prompt mutation, or
final recall outside its exact target set. Re-read live state, take a fresh
encrypted snapshot before any mutation, and regenerate stale candidate/quality
plans after every lifecycle change.
