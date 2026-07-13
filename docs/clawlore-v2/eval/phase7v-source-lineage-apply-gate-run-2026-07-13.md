# Phase 7V source-lineage apply gate — 2026-07-13

## Scope and boundary

Phase 7V turns the Phase 7U source-lineage plan into an executable,
transaction-scoped evidence-only apply path. This round implements and verifies
the path but does not run it against the live database. A live replay found one
new V1-only operational checkpoint, so the exact 981/981 Phase 7U plan correctly
failed closed before snapshot creation, transaction open, or evidence write.

The executor can attach only `sourceLineageReceiptV1` to the current source row
of exact planned targets. It cannot change canonical memory items, address,
lifecycle, verification, events, projections, pending outbox, ContextEngine,
prompt mutation, final recall, or V1 fallback.

## Implementation

Commit `9c58de7` adds:

- `live-source-lineage-receipt-apply.ts`, which requires an owner-only exact
  plan, a fresh restore-verified encrypted snapshot, and a byte-equivalent live
  plan replay before opening the database for write;
- transaction-local validation of every target's item/revision/address/
  lifecycle/verification digest, legacy source digest, and exact same-revision
  remembered-event digest;
- one-source-per-current-revision enforcement, duplicate-receipt rejection,
  non-target evidence protection, event/canonical/projection count protection,
  SQLite integrity and foreign-key checks before commit, and independent
  post-commit verification;
- an owner-only CLI receipt path and two focused regressions for exact bounded
  writes and event-drift rejection.

The planned receipt explicitly states that it supports source lineage only and
does not authorize lifecycle or verification change. Historical
`operator:approved-*` actors remain accepted only as immutable event evidence;
no approval-file gate was reintroduced.

## Fixture verification

- Phase 7U planner plus Phase 7V apply tests: 4/4 PASS;
- full suite: 202/202 PASS;
- typecheck and build: PASS;
- module boundaries: 2/2 PASS;
- runtime composition, ranking/promotion, Phase 7G controls, vector repair,
  golden recall, and release gate: PASS;
- release-gate package scan before this report: 428 files; closing scan after
  adding this report: 429 files.
- Gateway close: active/running, MainPID 328735, NRestarts 1, healthz live,
  port 19021 listening, and no warning-or-higher journal entries during the
  round.
- live scope-recall doctor: `ok=true`, issues 0, V1 SQL/FTS/vector 982/982/982,
  missing/stale vector rows 0, and SQL/vector scopes equal. This V1 health does
  not erase the separately measured V2/projection count of 981.

The fixture apply writes only two exact target receipts, keeps all rows
candidate/unverified, preserves the non-target source, and rejects replay. A
changed migration-event reason rejects the full operation before any receipt is
written.

## Live read-only preflight

Replaying the Phase 7U plan against live truth returned
`live source no longer matches remediation preview`. Read-only inspection then
proved the precise drift:

- V1/V2: 982/981;
- one unmirrored V1 row, source `session-pressure-guard`;
- classification: one operational checkpoint;
- proposed state: candidate/unverified with legacy-identity debt and operator
  review required;
- compatibility/current FTS/vector/relation projections: 981 each;
- lifecycle: 0 active / 661 candidate / 320 archived;
- pending outbox: 0;
- existing source-lineage receipts: 0;
- integrity: `ok`; foreign-key violations: 0.

No encrypted snapshot was created and no write transaction or live evidence
apply was attempted.

A separate owner-only, query-only r4 delta plan was retained at:

`workspace/archive/clawlore-phase7v-source-lineage-apply-preflight-20260713/v1-append-delta-plan-r4-20260713.json`

- file mode: 0600;
- file SHA-256:
  `da9a304639281a364c694946c9342590b123dc939f3ed9ab894fb713353da087`;
- proposed rollout:
  `clawlore-v2-v1-delta-migration-20260713-r4`;
- exact delta plan digest:
  `cef0b285d178bfdf0fdd27a518a184ee51ae121c4021de2ba715de31aa2c6c3a`;
- planned work: one Truth/compatibility/current FTS/vector/relation row and
  three processed outbox receipts;
- `authorizesDeltaWrite=false`; ContextEngine, prompt mutation, and final
  recall remain denied.

## Decision and next boundary

The Phase 7V apply implementation is release-gate ready, but the old 206-row
live plan is not executable against 982/981 truth. The next safe sequence is:

1. revalidate the exact r4 one-row delta under a fresh encrypted snapshot;
2. if that bounded live write is explicitly selected, restore V1/V2 and all
   projection counts to parity without changing existing candidate state;
3. regenerate the 662-candidate baseline, remediation plan, and source-lineage
   plan from the new live state;
4. only then consider a fresh-snapshot source-lineage receipt apply.

None of these evidence operations substitutes for content review or authorizes
lifecycle promotion, ContextEngine, prompt mutation, or final recall cutover.
