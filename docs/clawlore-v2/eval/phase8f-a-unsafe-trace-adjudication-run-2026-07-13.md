# Phase 8F-A unsafe trace adjudication — 2026-07-13

## Scope and result

Phase 8F-A handled the remaining 131 unsafe command, tool-payload, and
oversized operational traces as a read-only adjudication step. It did not
archive, rewrite, reject, verify, promote, or hard-delete any candidate.

The exact live plan split the lane into:

- 99 reversible soft-archive proposals;
- 32 bounded-rewrite holds, including all 7 oversized traces;
- 0 mutation-ready rows.

The 99 proposals are operational noise or facts already represented by durable
artifacts. The 32 holds contain material results or oversized content that
must be rewritten before any disposition. ContextEngine, prompt mutation,
lifecycle promotion, and final recall remained disabled.

## Live drift and exact r9 convergence

The 23:00 nightly extraction appended 15 V1 rows after Phase 8E, so the old
986/986 candidate baseline correctly failed closed before snapshot or write.
The new exact r9 plan covered only those 15 rows:

- 14 reflection summaries and 1 operational checkpoint;
- all candidate / unverified / legacy-identity debt;
- plan digest:
  `2bb1c49c6fa93fb8c177b024698025d391af5b4e43143cff892496bf05cf8374`;
- plan file SHA-256:
  `e6a16b1fc957f65cdd5983d058202677dc975aee8b27619377955ce7bc3fc655`.

A fresh encrypted snapshot was restored and verified before apply:

- archive SHA-256:
  `65e8df223242f01c8a8d2a261f749d5262143b81bb0107c59ff98548314c9c81`;
- source rows: 1001;
- source logical digest:
  `a3abdf7a84b4ddbe7114ae1831725d7f54b3b9a6fdd1e886f71a0b3c235601a5`.

The generalized batch acceptance then proved 15/15 exact rows and applied only
the additive V1 delta. V1/V2 and all four projections converged at 1001;
candidate became 664, active stayed 0, archived stayed 337, and pending outbox
stayed 0. Existing canonical, lifecycle, verification, and evidence changes
were all 0. SQLite integrity was ok and foreign-key violations were 0.

The implementation removes the previous single-row operational-checkpoint
assumption while retaining exact per-row hashes, complete batch shape, fresh
snapshot, transactional allowlists, and independent acceptance.

## Rebuilt live controls

All Phase 8E plans were treated as stale and rebuilt from live truth:

- policy: 0 eligible / 508 hold / 156 quarantine;
- remediation: 83 assignment review / 425 evidence review / 156 quarantine;
- content quality: 131 unsafe / 2 safe duplicate / 56 semantic review;
- unsafe primary lanes: 7 oversized / 109 command / 15 tool payload;
- mutation-ready: 0.

The new candidate-policy digest is
`d012a4c3375dc4d69302a95824f388fa9e555fdbc9dc9c5fccca45f0ead60e0d`.

## Read-only unsafe adjudication

The adjudicator rebinds the complete capture-safety plan to current live
item/revision/content/normalized-content/lineage digests and emits hashes plus
review metadata only. Its plan digest is
`23baa472329b981ff84792f7c6b52555dd5e6d1c789ede9b3cea6f53da6e7556`.

Disposition bases are:

- soft-archive proposals: 17 pure operational traces, 5 progress/smoke traces,
  24 project reports covered by durable artifacts, 8 stale external snapshots,
  43 transient runtime states, and 2 operation-completion traces;
- bounded-rewrite holds: 7 oversized traces requiring segmentation and 25
  semantic results requiring rewrite review.

The plan explicitly authorizes no soft archive, content rewrite, verification
change, lifecycle mutation, hard delete, ContextEngine, prompt mutation, or
final recall. Each later mutation needs its own exact control and a new fresh
encrypted snapshot.

## Recall parity and cutover boundary

The live corpus is complete at 1001/1001 with no missing or duplicate legacy
mapping, 13 normalization-only differences, and 3 substantive differences.
Those three are the intentional Phase 8C V2 durable rewrites, not missing data.
Because V2 has 0 active rows and 0 injectable recall evidence, the read-parity
tool correctly reports shadow/cutover not ready. Forbidden-scope leakage is 0.

This phase therefore provides no basis to enable lifecycle, ContextEngine,
prompt mutation, or final recall.

## Verification

- focused new-control tests: 10/10 PASS;
- full plugin tests: 236/236 PASS;
- typecheck and build: PASS;
- module-boundary, vector-repair, golden-recall, and release gates: PASS;
- golden recall / top-K: 1.0 / 1.0; forbidden-scope violations: 0;
- closing package scan: 504 files;
- Gateway: active/running, PID 328735, NRestarts 1, healthz live;
- doctor: ok, issues 0, SQL/FTS/vector 1001/1001/1001.
- project repository: clean after separate code/docs commits;
- workspace layout: `WORKSPACE_LAYOUT_OK` after removing the empty task tmp
  directory;
- state hygiene: the same 70 pre-existing outside-workspace backup/session/
  Codex-cache findings; no new ClawLore category;
- OpenClaw goal `6b780c84-f205-441d-bdc6-8c24a84435eb`: active and not
  duplicated or completed.

Code commit: `da25aba` (`feat: adjudicate unsafe candidate traces`).

## Evidence, cleanup, and next boundary

Owner-only controls and the encrypted rollback snapshot are retained at:

`archive/clawlore-phase8f-unsafe-disposition-20260713_2316/`

All retained controls are mode 0600 and the directory is mode 0700. Plaintext
restore databases, WAL/SHM files, temporary dependency trees, and debug logs
were removed. Phase 8F-B may independently apply the 99 soft-archive proposals
and develop bounded rewrite proposals for the 32 holds, but only under new
exact controls. Phase 8G and the Phase 9 cutover-or-no-cutover decision remain
separate.
