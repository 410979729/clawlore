# ClawLore v1 H5 production deployment run

Date: 2026-07-14

## Pre-restart transaction state

H5 entered live deployment only after H1-H4 had closed and the candidate
release gate proved that the previous live runtime differed from the candidate.
That negative gate ran 267/267 tests, typecheck, build, vector repair, and
golden recall before failing on the intended recursive identity check:
52 candidate runtime files were absent and 16 shared paths differed.

A fresh AES-256-GCM live snapshot was created and restored to a disposable
location. It bound 1005 memory rows, reported SQLite integrity `ok`, kept the
source stable during backup, matched schema and logical truth digests, and
removed the restored plaintext/WAL/SHM family. The encrypted archive and
receipt are owner-only in:

`workspace/archive/clawlore-v1-h5-production-hardening-20260714_210249/`

Before any live mutation, the existing runtime and configuration were backed
up outside plugin discovery. The compressed runtime backup SHA-256 is
`5951df22e19628e4eb67f58fca4bf524a8c694ed574ed2293c7c1128e47682f4`.

The exact live schema-hardening preview was `ready` with no orphan blockers.
Its digest-bound transaction migrated schema 2 to schema 3 and independently
postchecked:

- 1005 durable item identities;
- 1005 items, 1156 revisions/sources/events, 1005 ACL rows, 151 relations, and
  3015 processed outbox rows preserved;
- real foreign keys on all core references;
- zero foreign-key violations and SQLite integrity `ok`.

The candidate runtime was then staged and compared before replacement. The
candidate and deployed recursive artifact digests are both:

`c4e43382dbbf09379e51ba1334a8574fcf1369a496f7bb1246cdeb0c455d2251`

No missing, extra, different, or symlinked runtime artifact remained. The
legacy process continued to report a live health endpoint throughout this
pre-restart transaction.

The redacted shadow trace target was moved out of the historical archive into
`workspace/runtime/clawlore-v1/traces/runtime-shadow.jsonl`. The config schema
classified the field as hot-reloadable; the generic config patch API refused
the protected path without writing, so the scoped OpenClaw config setter was
used against the already-backed-up configuration and requested one restart.

## Post-restart runtime acceptance

The controlled Gateway restart completed at 21:18:05 CST. The post-restart
service remained `active/running` with result `success`, PID 700233 and restart
count 2. Port 19021 listened on the expected process and `/healthz` returned
`{"ok":true,"status":"live"}`.

The app-local OpenClaw 2026.7.1-beta.5 command surface inspected the loaded
extension at
`/home/a/openclaw-tianji/home/state/extensions/scope-recall-openclaw` and
reported:

- plugin `scope-recall-openclaw` 1.1.0 loaded and activated;
- memory slot selected;
- commands `scope-recall` and `memory-pro` present;
- configured mode `shadow` and ContextEngine selection `compatibility`;
- runtime log registration with one read-only observer, writes false, prompt
  mutation false, and ContextEngine false.

The live schema preview returned `already_hardened` at schema 3. It observed
1005 items, 1156 revisions/sources/events, 1005 ACL rows, 151 relations and
3015 processed outbox rows, with no blockers. Independent read-only checks
again returned SQLite integrity `ok` and zero foreign-key violations.

The default doctor returned `ok=true`, zero issues and 1005 SQL truth rows. A
recursive key-path scan of its default JSON found no notes, examples, session,
summary, or private-identifier fields.

## Default live release gate

The default release gate used the live state directory and app-local OpenClaw
binary; no source-only or runtime-smoke skip was set. It passed:

- 267/267 tests;
- typecheck, vector repair, build, and golden recall;
- known-answer recall and top-K accuracy 1.0, forbidden violations 0;
- candidate/deployed recursive identity with no dirty worktree;
- build commit `71e1659e9a3587ead9f299257dc52804a4a54bb7`;
- runtime digest
  `c4e43382dbbf09379e51ba1334a8574fcf1369a496f7bb1246cdeb0c455d2251`;
- CycloneDX SBOM 42 components, digest
  `32497426d55066625afd7bdeb81bd84267a0ad7d7757bc04a0043a719790dd2b`;
- package scan 564 files.

## Shadow fixtures, resource bounds, and soak

The exact deployed runtime modules were exercised against the live schema-3
database in read-only mode with three direct fixtures and one group-boundary
fixture. They registered only `message_received`; observer errors were empty,
and writes, prompt mutation and ContextEngine registration stayed false.

The resulting live trace contains 6 receipts: 5 completed and 1 skipped. The
audit accepted 4 direct and 1 group sample, with identity and policy preflight
passing for all 5 retrieval attempts. The trace is mode 0600, uses only the
allowlisted redacted/digest/count schema, contains no fixture query, principal,
conversation, raw-content, or memory-text value, and has no unexpected keys.

The positive candidate count remained zero. This is expected evidence, not a
probe failure: the current V2 corpus has no active/eligible rows and the legacy
principal debt remains non-injectable. The observation gate therefore remains
`observe` with the single blocker `positive_candidate_sample_missing`.

Seventeen focused regressions covering native boundary filtering, AbortSignal
propagation, timeout fail-open, deduplication, hard concurrency limits, group
scope handling, trace privacy, and observation gating all passed. A bounded
50-second service soak sampled health 12 times; all 12 were live, maximum
latency was 19 ms, the PID/restart count did not change, and no new Gateway or
ClawLore error was written.

## Fresh cutover decision

The new read-only decision receipt returned `no_cutover` from the current live
source:

- V1/V2/compatibility FTS/current FTS/vector/relation: 1005 each;
- candidate/active/archived: 569/0/436;
- candidate unverified: 493; active injectable: 0;
- eligible promotions: 0; lifecycle rollout not selectable;
- Phase 8G: 24 unapplied soft-archive proposals and 34 retained for review;
- current V1/V2 content differences: 47;
- pending outbox: 0; integrity `ok`; foreign-key violations 0;
- runtime cutover mode remains unimplemented.

The receipt preserves V1 fallback and read-only shadow. It authorizes no
lifecycle mutation, automatic promotion, ContextEngine, prompt mutation, V2
write, or final recall cutover.

Owner-only evidence is in
`workspace/archive/clawlore-v1-h5-production-hardening-20260714_210249/`:

- `post-restart-shadow-observation.receipt.json`;
- `post-restart-no-cutover.receipt.json`;
- `post-restart-acceptance.receipt.json` (combined artifact/service/gate/
  schema/shadow/decision receipt, SHA-256
  `0e392b57ddf817ce1d443d8c8a9470989c575a733aa3f0b3afd40c5946a528f1`).

## Final disposition and limits

H1-H5 production hardening is complete for the deployed read-only shadow
boundary. The hardened ClawLore v1 candidate is loaded in production alongside
the existing V1 fallback, but ClawLore native retrieval has not taken over
final recall. The correct release posture remains `NO-GO` for V2 writes,
native ContextEngine, lifecycle promotion, prompt mutation, and final recall
cutover.

The host default shell command `/opt/nodejs/bin/openclaw` is still
2026.7.1-beta.2 while the live service and all final acceptance checks used the
app-local 2026.7.1-beta.5 binary. This PATH mismatch is separate OpenClaw host
hygiene debt and did not alter the deployed plugin identity or H5 decision.

Rollback was not needed. The encrypted live snapshot, owner-only configuration
backup and runtime archive remain available in the H5 evidence directory.

## Cleanup and repository state

The project `node_modules` dependency symlink was removed after validation.
Twelve bounded `/tmp/clawlore-*` test directories left by earlier H1-H4 test
runs were removed; no current ClawLore/Scope Recall temporary directory remains
under `/tmp`. The live trace and five rollback/decision evidence files were
retained intentionally and remain mode 0600.

Because the trace is active mutable state rather than historical evidence,
`workspace/runtime/` was registered in `WORKSPACE_LAYOUT.md` and the layout
audit with an explicit private/redacted/rotated-only contract.
`WORKSPACE_LAYOUT_OK` now passes. The state hygiene audit still reports 76
category hits outside the workspace: 37 backup-like residues, 3 third-party
canonical documents under the Codex plugin cache, 4 root backup-sprawl hits,
and 32 session-backup residues. They predate H5 or are third-party cache
content and were not deleted as part of this project deployment.

The nested ClawLore project repository contains only this final report and plan
change for the closing commit; unrelated dirty state in the outer workspace
repository was not staged, modified for cleanup, or claimed as clean.
