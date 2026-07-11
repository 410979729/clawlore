# Phase 2B — Module Boundaries and Verified Snapshot Run (2026-07-11)

## Scope

Isolated source and temporary SQLite fixtures only. No live database was opened
or copied, no live extension/configuration was changed, and no Gateway or
ContextEngine operation occurred.

## Architecture preservation

The runtime capability model remains:

```text
SQLite truth -> transactional outbox -> FTS / vector / relations
```

SQL truth owns durable items, revisions, sources, ACL, events, and outbox.
FTS, vector, and relation/graph stores remain independent rebuildable
projections. Experience remains a separate application capability with
reviewed playbooks and operator governance.

`TruthStoreV2Port` now separates application services from the concrete SQLite
adapter. The module-boundary test rejects reverse imports. Its first run found
an existing OpenClaw adapter -> migration dependency; the pure legacy mapper
was moved into application and migration now provides only a compatibility
re-export.

## Snapshot and restore

- Online backup uses SQLite's backup API while the source store remains open.
- Snapshot verification checks SHA-256, Truth schema version, SQLite integrity,
  foreign-key violations, size, and all truth-table row counts.
- Restore writes only to a new path and repeats verification.
- A checksum or manifest mismatch fails closed.
- Failed/tampered restore destinations are removed.
- A fixture write made after snapshot creation did not appear in the restored
  database, proving point-in-time consistency.

The snapshot artifact in this phase is not yet an encrypted commercial backup
archive. Encryption and key-provider integration remain an explicit next gate.

## Verification

- Module-boundary tests: 2/2 PASS.
- Snapshot/restore tests: 2/2 PASS.
- Full test suite: 123/123 PASS.
- TypeScript typecheck: PASS.
- Build: PASS.
- Vector repair smoke: PASS.
- Golden recall: known-answer recall 1.0, forbidden violations 0, prompt-budget
  exceeded 0.
- Release gate: PASS; package scan 275 files.
