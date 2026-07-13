# Phase 7Z capture-safety operator batches — 2026-07-13

## Scope and outcome

Phase 7Z turns the 151 Phase 7Y capture-safety rejects into four exact,
query-only operator batches. It does not reject, rewrite, archive, verify, or
promote a memory. All rows remain candidate/unverified and all runtime cutover
controls remain disabled.

The planner first validates the complete owner-only Phase 7Y control and its
digest. It then binds every one of the 206 content-review rows back to its
current item, revision, raw-content digest, normalized-content digest,
category, and source-lineage receipt before selecting the 151 unsafe rows.
This prevents an apparently unchanged count from hiding row-level drift.

## Implementation

Commit `9de595b` adds:

- a pure capture-safety batch policy with explicit precedence and no automatic
  disposition;
- an owner-only live planner that accepts only the exact Phase 7Y query-only
  contract and fails closed on source, content, revision, category, or receipt
  drift;
- a CLI that creates one mode-0600 redacted review plan;
- regressions for the four batch lanes, mutating/tampered controls, and live
  content drift.

The first focused fixture used an `execution-result-block` sample rather than
the live `tool-fields-block` pattern. The production validator correctly
rejected it. The fixture was corrected to reproduce the live pattern; the
accepted pattern allowlist was not widened.

## Live query-only plan

The mode-0600 plan is retained at
`workspace/archive/clawlore-phase7z-capture-safety-review-20260713_171017/candidate-capture-safety-review-r1-20260713.json`.

- file SHA-256:
  `89a9f74e783cc525564768e5b34055f15dcaf96f3aa53bea3121ca296b911cf8`;
- plan digest:
  `b536bf16f13960716c235dbb0e77718bbd3b8dd35fd0b46f7c4d74b3ba0e5b79`;
- Phase 7Y plan digest:
  `d8e1a10e3e73d242bfba84409e14327858c4bf036213da5860666c9dc1c4250b`;
- exact targets: 151; automatic archive: 0; mutation-ready: 0.

Primary operator batches:

- 20 exact-duplicate operational-trace rows;
- 7 unique oversized operational-trace rows needing reject-or-bounded-rewrite
  review;
- 109 command-trace rejection-review rows;
- 15 tool-payload rejection-review rows.

Independent signals remain visible: 20 duplicate rows, 10 oversized rows, and
3 rows carrying both signals. Duplicate review has precedence, so overlapping
rows appear in exactly one primary batch without losing the oversized signal.

## Independent acceptance and boundary

Independent readback recomputed the plan digest and verified:

- 151 unique target hashes and 0 live binding mismatches;
- exact current revision, raw-content, normalized-content, category, and
  lineage-receipt digests for every row;
- an allowlisted row schema only, with no raw memory content, local path, or raw
  item/revision identifier in the serialized plan;
- V1/V2 and compatibility/current FTS/vector/relation remained 983;
- candidate 663 / active 0 / archived 320 / pending outbox 0.

The plan explicitly sets automatic archive, rejection mutation, content
rewrite, soft archive, hard delete, lifecycle mutation, verification mutation,
ContextEngine, prompt mutation, and final recall authority to false.

## Verification

- focused Phase 7Y/7Z tests: 6/6 PASS;
- full suite: 211/211 PASS;
- typecheck, build, vector repair, golden recall, runtime inspect/doctor, and
  release gate: PASS;
- closing package scan: 445 files.

The next safe step is operator adjudication within each batch. Any actual
rejection, bounded rewrite, canonical selection, archive, verification, or
lifecycle action requires a separate exact plan and independent acceptance.
