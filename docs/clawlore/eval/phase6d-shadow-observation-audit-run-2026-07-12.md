# Phase 6D shadow observation audit run — 2026-07-12

## Outcome

PASS. The read-only observation window is closed with real direct/private and
authorized group/conversation evidence. This decision does not authorize V2
writes, prompt mutation, ContextEngine, or Phase 7 activation.

## Delivered bundle

- `scripts/clawlore-shadow-observation-audit.mjs` reads an explicitly supplied
  JSONL trace path and emits machine-readable aggregate JSON only.
- It requires owner-only permissions, validates the redacted receipt/stage
  allowlists, and fails on unexpected payload fields or malformed counters.
- It reports status counts, identity/policy passes, retrieval invocations,
  accepted samples, positive-candidate samples, maxima, and a redacted latest
  summary. It does not print trace ids, principal hashes, message text, memory
  text, or rejection payloads.
- `tests/clawlore-shadow-observation-audit.test.mjs` covers a valid mixed trace,
  an unexpected raw-payload field, and group-readable permissions.
- The auditor can atomically write a 0600 redacted observation receipt. The
  receipt contains no trace id, principal hash, message, memory text, or path.
  It always records `authorizesV2Writes=false` and requires separate operator
  approval, including when the observation threshold eventually returns `go`.

## Live audit evidence

The auditor ran against the current 0600 live shadow trace and returned PASS:

- samples 6: completed 1, skipped 5;
- identity passes 1, policy passes 1, retrieval invocations 1;
- accepted samples 1, positive-candidate samples 0;
- maximum candidate/selected counts 0/0;
- issues 0.

The five skipped records predate the final `message_received` identity bridge.
The one accepted record is the real Joy Telegram direct message used for Phase
6C acceptance. No live configuration, database, prompt, or ContextEngine state
was changed by this slice.

At the direct-only checkpoint after the Phase 6D runtime restart, three real Joy
Telegram direct/private samples passed identity and policy and invoked
retrieval. All three returned bounded positive candidate counts; the latest
returned 5 candidates, selected 0, and changed no prompt. That checkpoint had
12 total records at mode 0600 with no schema/privacy issues. Its seven
`legacy_unknown` records did not count toward direct or group thresholds.

Joy's authorized Telegram group message at 16:38:41 CST produced a completed
live record with `ingressKind=group`, `visibility=conversation`, identity pass,
`same_conversation` policy pass, retrieval invoked, 6 bounded candidates, and
0 selected. The policy receipt explicitly recorded
`private_principal_mismatch`, proving private-principal candidates were rejected
rather than exposed to the group boundary.

The final live audit contains 16 records: 10 completed and 6 skipped. It has 10
accepted samples, including 6 direct/private and 1 group/conversation sample;
6 accepted samples returned positive bounded candidate counts, the maximum was
6, selected remained 0, and issues remained 0. The trace remains mode 0600.

The private receipt is stored under the rollout controls directory as
`phase6d-observation.json`. It was regenerated atomically at mode 0600 with
decision `go` and no blockers. Its safety section still sets writes, prompt
mutation, ContextEngine, and `authorizesV2Writes` to false and requires separate
operator approval.

## Verification

- Focused audit/receipt tests: 5/5 PASS.
- Full tests: 154/154 PASS.
- Typecheck and build: PASS.
- Release gate: PASS; package scan 334 files.

## Remaining work

Phase 6D has no remaining observation-boundary work. The later V2-write gate is
separate and remains disabled pending the Phase 7 migration, attribution,
encrypted-snapshot, rollback, readiness-receipt, and operator-approval gates.
