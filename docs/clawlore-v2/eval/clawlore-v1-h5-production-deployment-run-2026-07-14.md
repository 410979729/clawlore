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

## Pending restart acceptance

The controlled Gateway restart must now load the exact deployed artifact.
Post-restart acceptance will add runtime inspect identity, default live release
gate, doctor/health/schema checks, trace redaction and permissions, bounded
soak evidence, and the fresh cutover-or-no-cutover receipt. Until those checks
complete, V1 fallback, compatibility ContextEngine, and final-cutover disabled
remain the required boundary.
