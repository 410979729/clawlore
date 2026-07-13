# Phase 8E duplicate disposition live apply — 2026-07-13

## Scope and result

Phase 8E handled only the 14 reversible soft-archive proposals left separate
by Phases 8A–8D. It did not touch the durable rewrite representatives, the
remaining command/tool/oversized lanes, the two safe duplicates, or the 56
semantic-review rows.

The exact 5-group / 14-row plan was applied as a reversible lifecycle change:

- candidate rows: 663 -> 649;
- archived rows: 323 -> 337;
- active rows: 0 -> 0;
- hard deletes: 0;
- current content, verification, address, ACL, non-target rows: 0 changes;
- compatibility/current FTS, vector, relation projection, pending outbox: 0
  changes;
- V1/V2 and all projections remained 986/986.

ContextEngine, prompt mutation, lifecycle promotion, and final recall stayed
disabled. Archived projections were retained for compatibility and audit;
normal recall continues to suppress them through lifecycle filtering.

## Fail-closed preflight and live convergence

Two pre-write checks stopped safely before any database transaction:

1. the initial validator expected the wrong proposed-lifecycle/action shape;
   the control contract was corrected and covered by regression tests;
2. a newly appended operational checkpoint changed live V1/V2 from 985/985 to
   986/985, invalidating the old candidate baseline.

The V1 append was handled first under its own exact r8 control and a fresh,
restore-verified encrypted snapshot:

- r8 plan digest:
  `a79b611539e814696568763e09c8732058a01b031187b123005bbc91ab9ddd82`;
- pre-r8 snapshot archive SHA-256:
  `9e6e6cf102bd0bebeb1e9ff28cd26c8b851faaa294061b9cfa52c9d9d10d9aea`;
- r8 acceptance SHA-256:
  `95d75789803cec2740db978425e90d2c5872f156868b3679cffe425a28130b25`;
- cumulative delta acceptance digest:
  `92d00f38a78dfe3e570d6b707c924348d773af2c5ba59e2669474ae296782f77`.

The exact one-row candidate/unverified/legacy-identity migration restored
V1/V2 and all four projections to 986. Existing canonical, lifecycle,
verification, and evidence state changed by 0.

The prior candidate baseline was not reused blindly. A conservative append
rebase now accepts only an exact one-row operational checkpoint, preserves the
complete prior candidate set, adds that row as hold-only, and fails closed on
any other shape. The resulting pre-archive baseline was 663 candidates: 0
eligible / 507 hold / 156 quarantine.

## Exact archive transaction

After convergence, the live duplicate plan reproduced byte-for-byte:

- plan digest:
  `4806442c61c7ba28a26fad1461001a879504a5970b250d7473430d935b68cd54`;
- groups / rows: 5 / 14;
- covered by existing durable truth: 8 rows;
- transient operational traces: 6 rows;
- live binding mismatches: 0;
- raw trace or raw identifier leakage: 0.

A second fresh encrypted snapshot was restored and verified before apply:

- pre-archive snapshot archive SHA-256:
  `0f7b806f76d30c186af03bc8a4d0411841290d56b25d25b9b9a5e977ad97288d`.

The allowlisted transaction created 14 archived revisions, 14 source rows, 14
supersedes relations, and 14 archived events. It preserved all non-target and
runtime state. Independent postcheck then proved:

- archived target rows / groups: 14 / 5;
- valid disposition receipts: 14;
- supersedes relations / archived events / projection bindings: 14 / 14 / 14;
- mismatches: 0;
- SQLite integrity: ok; foreign-key violations: 0.

## Rebuilt live controls

All pre-archive candidate and quality plans were invalidated and rebuilt from
the 649-row live candidate set:

- policy: 0 eligible / 493 hold / 156 quarantine;
- remediation: 82 assignment review / 411 evidence review / 156 quarantine;
- content quality: 131 unsafe / 2 safe duplicate / 56 semantic review;
- unsafe primary lanes: 7 unique oversized / 109 command / 15 tool payload;
- exact-duplicate operational traces remaining: 0;
- automatic archive / mutation-ready: 0 / 0.

This confirms that Phase 8E removed exactly the earlier 14-row duplicate lane
without authorizing any further disposition.

## Verification

- focused duplicate/archive tests: 4/4 PASS;
- full plugin tests: 233/233 PASS;
- typecheck and build: PASS;
- module-boundary, runtime-composition, ranking/promotion, Phase 7G controls,
  vector-repair, golden-recall, and release gates: PASS;
- golden recall / top-K: 1.0 / 1.0; forbidden-scope violations: 0;
- closing package scan: 492 files;
- Gateway: active/running, PID 328735, NRestarts 1, healthz live;
- runtime registration: shadow, hooks=1, writes=false,
  promptMutation=false, contextEngine=false, blocks=none;
- doctor: ok, issues 0, SQL/FTS/vector 986/986/986.

Code commit: `8e0ed3c` (`feat(clawlore): add exact duplicate archive controls`).

## Evidence, cleanup, and next boundary

Owner-only controls and the two encrypted rollback snapshots are retained at:

`archive/clawlore-phase8e-duplicate-disposition-20260713_215037/`

All controls are mode 0600. Plaintext restore databases, WAL/SHM files, and
temporary test artifacts were removed. The next bounded work is Phase 8F for
the 7 oversized, 109 command, and 15 tool-payload rows. Phase 8G and the final
Phase 9 cutover-or-no-cutover decision remain separate. Nothing in Phase 8E
authorizes lifecycle promotion, ContextEngine, prompt mutation, or final recall.
