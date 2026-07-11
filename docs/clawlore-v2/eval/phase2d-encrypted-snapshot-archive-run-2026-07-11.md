# Phase 2D — Encrypted Snapshot Archive Run (2026-07-11)

## Scope

Temporary Truth V2 SQLite fixtures and generated archive files only. The live
memory database, plugin, configuration, hooks, ContextEngine, and Gateway were
not changed.

## Contract

- Create a verified online SQLite snapshot before encryption.
- Wrap the snapshot with AES-256-GCM and a random 96-bit IV.
- Resolve the 256-bit archive key through a file SecretRef-style provider;
  credential values never enter config, manifests, logs, or tests.
- Reject a key file with group/other permission bits; accept 0600 or stricter.
- Store the archive as 0600 and bind algorithm, key id, snapshot checksum,
  schema, integrity, foreign-key status, and table counts into its header.
- Verify the outer archive checksum before decryption and the inner SQLite
  checksum/integrity after authenticated decryption.
- Restore only to a new location and remove all temporary plaintext SQLite,
  `-wal`, and `-shm` files on success or failure.

## Failure found and repaired

The first focused run found that SQLite inspection could leave plaintext
`-wal` and `-shm` sidecars after the main temporary snapshot was removed. The
cleanup boundary was expanded to remove the complete SQLite file family. The
focused test was rerun and passed.

## Verification

- Encrypted archive tests: 3/3 PASS.
- Full test suite: 128/128 PASS.
- TypeScript typecheck and build: PASS.
- Module-boundary smoke: 2/2 PASS.
- Wrong-key restore: rejected; no destination or decrypted temp remains.
- File SecretRef permission gate: PASS.
- Plaintext/archive-content and temporary-sidecar checks: PASS.
- Vector-repair smoke and golden recall: PASS.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Release gate: PASS; package scan 283 files.

