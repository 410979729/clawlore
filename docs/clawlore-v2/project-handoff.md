# ClawLore 2.0 project handoff

Current through Phase 9 and active ClawLore v1 production hardening H1 on
2026-07-14.

## Independent audit reopening

The original route remains correctly closed at Phase 9 `no_cutover`, but an
independent read-only audit found five P1 production blockers plus release,
diagnostic, resource-bound, and maintainability debt. ClawLore v1 is therefore
a candidate/shadow architecture, not a completed production cutover.

The new bounded route is recorded in
`clawlore-v1-production-hardening-plan.md`. H1 now routes correct/forget through
the unified address policy, preserves non-active lifecycle during correction,
rejects correction-as-restore, and redacts digest diagnostics. Focused
adversarial tests are 8/8 PASS and typecheck passes. Full bundle gates remain
open; live extension/config/database/service are unchanged.

## Live position

- OpenClaw runtime remains read-only shadow: hooks=1, writes=false,
  promptMutation=false, ContextEngine=false, final recall=false.
- Live V1/V2/compatibility FTS/current FTS/vector/relation are 1005 each;
  candidate 569, active 0, archived 436, pending outbox 0. Integrity is `ok`
  and foreign-key violations are 0.
- Current candidate policy is 0 eligible / 411 hold / 156 quarantine. Phase 8G
  closes the exact 2 safe duplicates + 56 semantic rows as 24 reversible
  archive proposals and 34 retained-for-verification candidates.
- Phase 9 decision is `no_cutover`; V1 fallback and shadow remain authoritative.

## Latest completed phase

Phase 8F-B3B first converged the exact two-row r12 append under a fresh encrypted
snapshot. A second snapshot then bound the accepted owner-only payload to an
exact 32-row rewrite transaction. The apply created 32 revisions, sources,
supersedes relations, events, and current-FTS updates while preserving V1,
lifecycle, verification, address, ACL, other projections, outbox, non-target
rows, and runtime gates. Independent postcheck found zero mismatches.

Phase 8G introduced receipt-aware closure so the 32 rewritten rows are not
reintroduced into the generic semantic queue. Authenticated private review
covered all remaining 58 rows without emitting their prose or raw ids. It
proposes 24 exact soft archives and retains 34 durable candidates pending
verification; rewrite holds are 0. The result is query-only.

Phase 9 binds live configuration and database truth into an explicit
`no_cutover` receipt. Active/injectable rows and eligible promotions are 0,
candidate verification debt remains, 24 archive proposals are unapplied, 47
current V1/V2 content differences exist, and runtime cutover is not implemented.

- full tests: 255/255 PASS;
- focused Phase 8G/9: 6/6 PASS;
- typecheck/build/module/runtime/vector/golden/release: PASS;
- release package scan: 547 files;
- code commit: `96d9bfe`;
- run report:
  `eval/phase8f-b3b-phase8g-phase9-completion-run-2026-07-14.md`.

## Closed boundary and future work

The planned ClawLore v2 route is complete through Phase 9. `no_cutover` is the
completed decision, not an implied approval to enable V2 injection.

Future work is a new scope: either execute selected Phase 8G archive proposals
under a fresh exact transaction, acquire promotion-grade evidence for retained
candidates, or implement and separately authorize a real runtime cutover mode.
Any such work must re-read live truth and create new controls; none may reuse
the Phase 8F/8G query-only authority as write permission.
