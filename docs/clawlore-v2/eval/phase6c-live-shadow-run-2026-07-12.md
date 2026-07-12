# Phase 6C live read-only shadow run — 2026-07-12

## Outcome

PASS for live read-only shadow acceptance. This is not approval for V2 writes,
prompt mutation, ContextEngine, or final recall cutover.

The first attempted ingress, `inbound_claim`, was unsuitable because OpenClaw
only emits it for plugin-bound routing. The deployed observer now uses the
generic `message_received` hook, resolves trusted sender identity from the
actual ingress event, preserves direct/group boundaries, and fails toward
conversation scope when chat type is unknown.

## Live evidence

- `openclaw-gateway-tianji.service`: active/running, main process started at
  2026-07-12 13:07:25 CST.
- `http://127.0.0.1:19021/healthz`: `{"ok":true,"status":"live"}`.
- Recent Gateway receipt: runtime `registered`, mode `shadow`, hooks 1,
  writes false, prompt mutation false, ContextEngine false, blocking reasons
  none.
- Live and candidate SHA-256 hashes match for both runtime-composition source
  and compiled dist artifacts.
- The registered hook type is `message_received`; the receipt type only permits
  `registeredHooks: Array<"message_received">`.
- The redacted runtime trace is owned by the Tianji service user with mode 0600.
- The Joy Telegram direct message received at 13:58:08 produced a completed
  trace at 13:58:08.713: identity pass, same-private-principal policy pass,
  retrieval invoked, candidate count 0, selected count 0, used tokens 0.
- The trace contains only an opaque trace id, a principal hash, stage results,
  and counts; it contains no raw message, memory text, or principal id.
- The complete Truth/Experience V2 table set was queried through
  `sqlite3 -readonly`; live V2 table count is 0.

Candidate count 0 is a valid retrieval result for the operational question
used as this acceptance sample. It proves the hook invoked retrieval; it does
not claim recall quality from a positive-candidate live sample.

## Regression evidence

- Full tests: 149/149 PASS.
- Typecheck and build: PASS.
- Runtime-composition smoke: one registered shadow hook, retrieval invoked,
  one fixture candidate selected, zero tools/writes/prompt mutation/
  ContextEngine registration.
- Module boundaries: 2/2 PASS.
- Vector-repair smoke: PASS.
- Golden recall: known-answer recall 1.0, top-k accuracy 1.0, forbidden
  violations 0, prompt-budget exceedances 0.
- Release gate: PASS; package scan 330 files.

## Remaining gate

Phase 6D keeps the deployment read-only while gathering more real ingress
samples, including an authorized group-boundary sample, and records an explicit
go/no-go receipt. Phase 7 V2 writes require a fresh encrypted snapshot,
migration preview, verification-debt review, rollback evidence, and separate
operator approval. ContextEngine remains out of scope.
