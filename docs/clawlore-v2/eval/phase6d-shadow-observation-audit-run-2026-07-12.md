# Phase 6D shadow observation audit run — 2026-07-12

## Outcome

PASS for the read-only observation-audit and private receipt slice. Phase 6D
remains open only because one authorized real group-boundary sample has not yet
been collected.

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

After the Phase 6D runtime restart, three real Joy Telegram direct/private
samples passed identity and policy and invoked retrieval. All three returned
bounded positive candidate counts; the latest returned 5 candidates, selected
0, and changed no prompt. The live trace has 12 total records, remains 0600,
and has no schema/privacy issues. The seven pre-restart records remain
`legacy_unknown` and do not count toward direct or group thresholds.

The current private receipt is stored under the rollout controls directory as
`phase6d-observation.json`. Its decision is `observe`; its only blocker is
`group_boundary_sample_missing`. It explicitly keeps writes, prompt mutation,
and ContextEngine disabled and does not authorize Phase 7.

## Verification

- Focused audit/receipt tests: 5/5 PASS.
- Full tests: 154/154 PASS.
- Typecheck and build: PASS.
- Release gate: PASS; package scan 334 files.

## Remaining work

Collect one authorized real group event and prove the receipt records
group/conversation visibility without private-principal visibility. It must not
be fabricated from a continuation or fixture. Then regenerate the receipt and
close Phase 6D only if the decision becomes `go` with no issues. The later
V2-write gate remains separate and disabled.
