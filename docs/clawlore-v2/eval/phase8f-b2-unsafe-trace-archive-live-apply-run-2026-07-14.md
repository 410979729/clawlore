# Phase 8F-B2 unsafe trace archive live apply — 2026-07-14

## Scope and result

Phase 8F-B2 applied only the exact reversible archive lane designed in Phase
8F-B1:

- 99 unsafe operational-trace candidates were soft-archived;
- all 32 bounded-rewrite targets remained candidate/unverified and unchanged;
- no hard delete, content rewrite, verification, address, ACL, lifecycle
  promotion, ContextEngine, prompt mutation, or final recall change occurred.

The live lifecycle moved from 666 candidate / 337 archived to 567 candidate /
436 archived. Active remained 0 and pending outbox remained 0.

## Drift rejection and exact r11 convergence

The first replay of the Phase 8F-B1 plan correctly failed closed before any
write because a new V1 operational checkpoint had changed live truth from
1002/1002 to 1003/1002. The stale plan was not reused.

A separate exact r11 plan bound only that one append:

- plan digest:
  `e7bb8d5ae8627e809f9a331f1949bbbf9e6cf40dacccf35228caf22adc8c51b6`;
- pre-r11 encrypted snapshot SHA-256:
  `950cea6bfe6e4f48a2cd53883ac33299d82d18f0eb10bce57d59f1e1f3226107`.

Restore verification passed before apply. The exact transaction appended the
single candidate/unverified/legacy-identity-debt row and restored V1/V2 plus
compatibility FTS, current FTS, vector, and relation projections to 1003.
Candidate became 666; archived stayed 337. Existing canonical, lifecycle,
verification, and evidence changes were 0.

Every candidate control was then regenerated from live truth. Independent
acceptance matched the new 99/32 split with overlap 0 and disposition-plan
digest:

`504faad27d710abfbb840254cdb0977b95f2d8047219e76d05776fef4f1c3ecb`

## Exact 99-row archive transaction

A second fresh encrypted snapshot was restored and verified before the archive
transaction:

- pre-archive snapshot SHA-256:
  `1d70efe5886e66fa55beb12167c5c47660828a9b25b1191ec375333a91c4b1ba`;
- exact archive targets: 99;
- protected rewrite targets: 32;
- target overlap: 0.

The transaction changed only the allowlisted archive lane:

- candidate: 666 -> 567;
- archived: 337 -> 436;
- active: 0 -> 0;
- V1/V2/four projections: 1003/1003, unchanged;
- protected rewrite-target changes: 0;
- non-target content/verification/address/ACL/projection/outbox changes: 0;
- new archived revisions, archived sources, supersedes relations, lifecycle
  events, and disposition receipts: 99 each;
- SQLite integrity: ok; foreign-key violations: 0.

The independent postcheck recomputed 99 archived targets, 32 protected rewrite
targets, 99 valid receipts, 99 supersedes relations, 99 lifecycle events, and
99 projection bindings with 0 mismatches.

## Post-archive rebase

All pre-archive controls were invalidated and rebuilt from the new live
lifecycle baseline:

- policy: 0 eligible / 411 hold / 156 quarantine;
- remediation: 85 assignment / 326 evidence / 156 quarantine;
- content review: 32 unsafe / 2 safe duplicate / 56 semantic review;
- capture-safety lanes: 7 oversized / 18 command / 7 tool payload;
- unsafe disposition: 0 archive proposals / 32 rewrite holds;
- rebase digest:
  `74bf071e685f705b87a902183843dd91bc268135c7233c686407aa261c847426`.

The remaining 32 unsafe rows are 7 oversized and 25 semantic-result rewrite
holds. They require a payload-bearing proposal and separate exact rewrite
authority in Phase 8F-B3.

## Verification

- focused archive tests: 6/6 PASS;
- full plugin tests: 242/242 PASS;
- typecheck and build: PASS;
- release, vector-repair, and golden-recall gates: PASS;
- golden recall / top-K: 1.0 / 1.0; forbidden-scope violations: 0;
- closing package scan: 521 files;
- Gateway: active/running, PID 328735, NRestarts 1, healthz live;
- doctor: ok, issues 0, SQL/FTS/vector 1003/1003/1003;
- recent phase-window ClawLore/Gateway fault matches: 0;
- OpenClaw goal `6b780c84-f205-441d-bdc6-8c24a84435eb`: active, not
  duplicated, and not completed.

Code commit: `379f326` (`feat(clawlore): archive unsafe trace candidates exactly`).

## Evidence, cleanup, and next boundary

The two encrypted snapshots and owner-only acceptance/apply/postcheck evidence
are retained at:

`archive/clawlore-phase8f-b2-unsafe-archive-20260714_0114/`

The directory is retained for rollback and audit only. Plaintext restore
databases, WAL/SHM files, temporary dependency trees, and npm debug logs are
removed before handoff.

Phase 8F-B3 may design and apply only the remaining 32 bounded rewrites under a
new payload-bearing plan, fresh encrypted snapshot, exact acceptance, and
separate transaction. Phase 8G still owns the 2 safe duplicates and 56
semantic-review rows. Phase 9 remains an explicit cutover-or-no-cutover
decision; this phase grants no cutover authority.
