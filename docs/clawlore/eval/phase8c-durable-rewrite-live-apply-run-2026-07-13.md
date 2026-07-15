# Phase 8C durable rewrite live apply — 2026-07-13

## Scope and outcome

Phase 8C applies only the three deterministic rewrite representatives accepted
in Phase 8B. It leaves the three companions unchanged and preserves every
current item as candidate/unverified. The transaction does not change V1 truth,
addresses, ACL, compatibility/vector/relation projections, pending outbox,
ContextEngine, prompt mutation, or final recall.

The live apply completed under a fresh encrypted snapshot. Three new current
revisions were inserted, the three prior representative revisions were marked
superseded for revision-history bookkeeping, and the current item lifecycle and
verification values did not change. Each new source retains the existing
source-lineage receipt and adds a bounded `durableRewriteReceiptV1`.

## Pre-apply convergence

The first preflight found a new V1-only operational checkpoint: V1/V2 were
985/984. A regression in the continuous-append baseline path was also exposed:
an already accepted V2 delta ceased to be query-valid when a later V1-only row
appeared. Commit `a5e2436` changes the accepted-delta comparison from exact V1
equality to monotonic V1 growth while leaving `unmirroredV1Rows` as the cutover
blocker, and adds a regression for that state.

The r7 plan contained exactly one `operational_checkpoint / candidate /
unverified` row, invalid metadata 0, and no write authority. A restore-verified
encrypted snapshot then bound V1 logical digest
`c792ea649f6ec32e04227579b7888c4c67c192227b11565b5fc008924aec3c82`.
The exact r7 apply restored V1/V2 and all four projections to 985, candidate to
665, active to 0, archived to 320, and pending outbox to 0. A cumulative four-row
delta acceptance and a new zero-eligible candidate baseline were produced before
the rewrite transaction.

## Exact three-row transaction

The owner-only Phase 8C evidence is retained under
`workspace/archive/clawlore-phase8c-durable-rewrite-apply-20260713_1830/`.

- Phase 8B plan digest:
  `b2e1aec83c054039a942ec1db5769f0da3965bbf84ad5cee438655afcf085d78`;
- post-r7 candidate baseline digest:
  `c89de4408c1ff7a3360db3035a0d4175e9ef2f3e0dfe05b470e1a1d6288d001c`;
- pre-rewrite encrypted archive SHA-256:
  `50e6a6a8ac21987c7d457fe5305e0b73322b244ebeb073d3385667a7caa63fcf`;
- apply receipt SHA-256:
  `184513de9450793f5d56703bf2506a42df357aaa1e6f61effb94f9c217ae6de8`;
- independent postcheck: 3 representatives, 3 companions, 3 valid rewrite
  receipts, 0 mismatches.

The exact boundary was:

- new revisions/sources/supersedes relations/events: 3 each;
- current representative content and current FTS rows changed: 3 each;
- historical representative revisions marked superseded: 3;
- current lifecycle, current verification, address, ACL, companion, and
  non-target changes: 0;
- compatibility, vector, relation-projection, and pending-outbox changes: 0;
- V1 logical truth changes: 0.

## Post-rewrite planning

The remediation and quality controls were rebuilt from current live truth; no
Phase 8A/8B content binding was reused as a post-rewrite decision.

- candidate remediation: 665 total, 509 policy holds, 156 policy quarantines,
  mutation-ready 0;
- content quality: 206 targets, 148 capture-safety rejects, 16 exact-duplicate
  rows in 6 groups, 10 oversized rows, and 56 manual semantic-review rows;
- primary lanes: 148 unsafe review / 2 safe duplicate review / 56 manual
  semantic review;
- capture-safety batches: 14 exact-duplicate traces, 7 unique oversized traces,
  111 command traces, and 16 tool payloads;
- all rebuilt controls remain query-only and non-authorizing.

Compared with Phase 7Y/7Z, the three rewritten representatives have left the
unsafe lane: capture-safety rejects fell from 151 to 148, unsafe exact-duplicate
rows fell from 20 to 14, and manual semantic review rose from 53 to 56. The
three companions remain candidate/unverified and require a new Phase 8D
decision; no archive was inferred from the successful rewrite.

## Verification and live evidence

- focused tests: 16/16 PASS;
- full suite: 224/224 PASS;
- typecheck, build, module-boundary, runtime-composition, ranking, Phase 7G
  controls, vector-repair, golden-recall, and release gate: PASS;
- release pack scan: 464 files;
- golden recall 1.0, forbidden violations 0;
- scope-recall doctor: `ok=true`, issues 0, SQL/FTS/vector 985/985/985;
- database integrity `ok`, foreign-key violations 0;
- Gateway `active/running`, MainPID 328735, NRestarts 1, healthz live, with no
  warning journal entries in the Phase 8C window.

The doctor also reports existing provider-plugin API/version warnings; they are
outside ClawLore and did not affect doctor health or this transaction.

## Cleanup and remaining roadmap

Plaintext restore-test files are absent. The encrypted snapshots and minimal
mode-0600 controls remain for rollback/audit. Development dependencies are
removed at close; no temporary database, WAL/SHM, lock, or test log is retained.

After Phase 8C, the bounded roadmap has five planned decision phases, subject to
new live evidence: Phase 8D companion disposition, Phase 8E the separate 14-row
reversible archive lane, Phase 8F the remaining unsafe command/tool/oversized
lanes, Phase 8G the 2 safe duplicates plus 56 semantic-review rows, and Phase 9
the explicit lifecycle/final-recall cutover-or-no-cutover decision. These are a
planning estimate, not pre-authorized writes.
