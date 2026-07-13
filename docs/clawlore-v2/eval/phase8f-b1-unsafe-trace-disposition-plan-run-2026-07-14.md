# Phase 8F-B1 unsafe trace disposition plan — 2026-07-14

## Scope and result

Phase 8F-B1 converted the exact Phase 8F-A adjudication into two independent,
query-only disposition lanes:

- 99 reversible soft-archive targets;
- 32 bounded rewrite designs: 7 oversized-result segmentation designs and 25
  durable-result extraction designs;
- 0 mutation-ready rows.

This phase did not archive, rewrite, verify, promote, reject, or hard-delete any
candidate. It authorizes no lifecycle, ContextEngine, prompt mutation, or final
recall change. The archive and rewrite lanes remain proposals that require
separate exact controls and a new fresh encrypted snapshot before any mutation.

## Live drift and exact r10 convergence

The first live disposition replay correctly failed closed because a new V1
operational checkpoint had appeared after Phase 8F-A, producing V1/V2
1002/1001. No disposition receipt or write transaction was created.

A separate read-only r10 delta plan bound exactly that one row as
candidate/unverified/legacy-identity debt:

- plan digest:
  `7b11aba58b6af2e36f2fb7629a0099363ec3ad3ea38d1693ef279695ef1f578e`;
- rollout: `clawlore-v2-v1-append-20260714-r10`.

The fresh encrypted snapshot was restored and verified before apply:

- archive SHA-256:
  `fc9de8cdcb2e07a61e02cedc28bf1e7d4491f12fa1ec0414e3d4ee34da117ff0`;
- source rows: 1002;
- source logical digest:
  `fe5e45ccf5149868e4908443f42c55bc3a74c3aa82e0500f1e5e6fc40c447c6b`;
- SQLite integrity: ok; foreign-key violations: 0.

The exact r10 transaction appended only that row. V1/V2 and the compatibility,
current FTS, vector, and relation projections converged at 1002. Candidate
became 665; active remained 0, archived remained 337, and pending outbox
remained 0. Existing canonical, lifecycle, verification, and evidence changes
were all 0.

## Rebuilt controls and disposition design

Every pre-r10 candidate plan was treated as stale and rebuilt from live truth:

- policy: 0 eligible / 509 hold / 156 quarantine, digest
  `7d743874f575d2fbc3523043da4e1d472ffbb4bcda7d31a081eead862b127ad1`;
- remediation: 84 assignment / 425 evidence / 156 quarantine, digest
  `eb564f31b71d29ab7e053bd3faf27461b6de9b21c9511d81eee147c308393866`;
- content quality: 131 unsafe / 2 safe duplicate / 56 semantic review,
  digest `b0002984949683ed449d9fbf6c76bd4b54d62074bcb31d939f847645953bf77c`;
- capture safety: 7 oversized / 109 command / 15 tool payload, digest
  `eebac79b55e1a7e3d1491ccdc9ad9d7fb524da1fe2768c87f3b11c83fb454f4c`;
- unsafe adjudication: 99 soft-archive proposals / 32 bounded-rewrite holds,
  digest `87ce706d22312bb6809d441f804438c5f15bdd66d7f3f6973ccff89cab4ff919`.

The new planner emits only hashes, disposition metadata, and bounded rewrite
requirements. Oversized rows may produce at most four capture-safe segments;
semantic rows may produce at most one durable result. Every rewrite must remove
command/tool envelopes, pass capture safety, and pass corpus deduplication.
Archive rows retain archived/unverified as the proposed state; rewrite rows
retain candidate/unverified. Neither lane is executable in this phase.

The final owner-only plan has digest
`527e209f01ee8b8299eb77fe033c8f75ddb580398bec6646b0ee401792d09adc`.
An independent recomputation matched the digest exactly and proved 99 unique
archive targets plus 32 unique rewrite targets, overlap 0, union 131, forbidden
raw/content keys 0, and mutation-ready 0. It explicitly requires a fresh
encrypted snapshot and a separate exact apply.

## Verification

- focused disposition tests: 4/4 PASS;
- full plugin tests: 238/238 PASS;
- typecheck and build: PASS;
- module-boundary, vector-repair, golden-recall, and release gates: PASS;
- golden recall / top-K: 1.0 / 1.0; forbidden-scope violations: 0;
- closing package scan: 511 files;
- Gateway: active/running, PID 328735, NRestarts 1, healthz live;
- doctor: ok, issues 0, SQL/FTS/vector 1002/1002/1002;
- recent phase-window Gateway warning/error matches: 0;
- OpenClaw goal `6b780c84-f205-441d-bdc6-8c24a84435eb`: active, not
  duplicated, and not completed.

Code commit: `b81a7d1` (`feat: plan unsafe trace dispositions`).

## Evidence, cleanup, and next boundary

The restore-verified encrypted snapshot and owner-only controls are retained at:

`archive/clawlore-phase8f-b1-unsafe-disposition-20260714_0020/`

The directory is mode 0700 and retained controls are mode 0600. Plaintext
restore databases, WAL/SHM files, temporary dependency trees, and npm debug
logs were removed before handoff.

Phase 8F-B2 may apply only the exact 99-row soft-archive lane after a new fresh
encrypted snapshot and a separate independent acceptance. The 32 rewrite
designs require a later payload-bearing proposal and exact rewrite transaction;
they are not archive authority. Phase 8G and the Phase 9 cutover-or-no-cutover
decision remain independent.
