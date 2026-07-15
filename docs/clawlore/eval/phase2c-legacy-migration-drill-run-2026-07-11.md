# Phase 2C — Legacy Migration Drill Run (2026-07-11)

## Scope

Temporary legacy and V2 SQLite fixtures only. The live memory database was not
opened, copied, altered, or migrated.

## Workflow

1. Open the legacy `memory_truth` database read-only.
2. Validate required legacy columns.
3. Produce a content-redacted plan containing row hashes, classification,
   lifecycle, verification, identity debt, and a stable plan digest.
4. Require explicit approval, the same plan digest, and a non-existent
   destination before apply.
5. Create a separate Truth V2 database; never add V2 tables to the legacy file.
6. Write a 0600 migration marker containing migration id, digest, count, and
   timestamp.
7. Roll back only when marker id and digest match; remove the additive V2
   database and marker while leaving legacy truth untouched.

## Mapping safety

- Resolved manual/user-confirmed rows may become active.
- Auto-capture or unresolved identity rows remain unverified candidates.
- Archived, rejected, superseded, or purged legacy rows remain non-active.
- Source evidence records legacy classification, old scope, review status, and
  verification debt.
- A stale preview digest fails before any destination is created.

## Verification

- Migration drill tests: 2/2 PASS.
- Legacy database SHA-256 unchanged across preview, apply, and rollback.
- Full test suite: 125/125 PASS.
- TypeScript typecheck, build, vector-repair smoke, golden recall, and release
  gate: PASS.
- Release package scan: 279 files.
- Golden recall: 1.0, forbidden violations 0, prompt-budget exceeded 0.
