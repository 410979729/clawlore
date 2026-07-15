# Phase 2A — Truth and Runtime Spine Run (2026-07-11)

## Scope

Isolated implementation and fixture verification only. No live extension,
configuration, memory database, hook registration, ContextEngine slot, or
Gateway restart was involved.

## Delivered

- Default-off runtime shadow with redacted trace fields and zero retrieval when
  disabled.
- Additive Truth V2 schema for current items, immutable revisions, sources,
  ACL, relations, audit events, and transactional projection outbox.
- Atomic remember/correct/archive/purge services with rollback on partial
  failure and explicit approval for purge.
- Read-only legacy migration preview that preserves verification debt.
- Unified distillation admission path for explicit user truth, tool evidence,
  unverified inference candidates, secret rejection, and deduplication.
- Retryable projection worker whose failures do not corrupt SQL truth.
- Four-action Agent facade: query, remember, correct, and forget.
- SQL access filtering before row return for private, conversation/thread, and
  project visibility. Expired, cross-boundary, ungranted team/global, and
  invalid-actor queries fail closed.
- Compatibility-first ContextEngine capability negotiation skeleton. Native
  activation remains opt-in and requires every declared host capability.

## Release-gate correction

The first gate run failed because its legacy assertion still required stats and
replay tools to be discoverable. That contradicted the Phase 1C operator-plane
hardening. The gate now requires boolean metadata for every Experience tool,
allows only playbook search/inspect/preflight by default, and requires all other
Experience tools to remain non-discoverable behind the management signal.

## Verification

- Focused Agent facade/ContextEngine tests: 2/2 PASS.
- Latest runtime shadow/Truth V2/distillation focused tests: 7/7 PASS before
  this slice; all are also included in the full regression.
- Full test suite: 119/119 PASS.
- TypeScript typecheck: PASS.
- Build: PASS.
- Release gate: PASS.
- Package scan: 265 files.
- Golden recall: known-answer recall 1.0, top-k accuracy 1.0, forbidden
  violations 0, prompt-budget exceeded 0.

## Remaining boundary

This is an isolated kernel milestone, not a live rollout or a completed 2.0
product. Migration apply/rollback, verified backup/restore, legacy trigger
adaptation, product UI, subagent Experience lifecycle, compatibility release,
and live cutover remain separate gated work.
