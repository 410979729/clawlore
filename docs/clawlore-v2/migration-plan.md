# Migration plan: scope-recall-openclaw 1.1.0 to ClawLore 2.0

## Invariants

- Preview is read-only and runs against a copied or fixture database.
- Legacy tables and source metadata are preserved throughout one full major
  compatibility cycle.
- Unknown legacy identity or scope becomes explicit verification debt; it is
  never silently promoted to confirmed active memory.
- Every apply requires an online SQLite snapshot, manifest, checksums, schema
  version, actor, reason, batch id, and rollback instructions.
- Restore happens into a new location and is verified before atomic cutover.

## Stages

1. Inventory current schema, source categories, scope distribution, metadata
   coverage, vector drift, and plaintext export exposure.
2. Map legacy rows with the pure preview mapper and emit debt counts.
3. Create additive v2 tables without deleting or renaming v1 tables.
4. Dual-read in shadow mode and compare ids, rankings, policy decisions,
   freshness, conflicts, and forbidden-scope leakage.
5. Enable v2 writes while retaining v1 fallback reads.
6. Rebuild projections from v2 SQL truth and verify checksums/counts.
7. Cut over only after quality gates and operator approval.
8. Roll back by restoring the pre-apply snapshot and configuration pointer;
   never attempt an in-place reverse rewrite of partially migrated rows.

## Execution ledger discipline

- This plan remains the stage-order authority. Current completion and evidence
  live in `TODO-clawlore-v2.md`, the project handoff, dated run reports, and the
  current day log; a later phase must map back to one of the stages above.
- The current Phase 7D write and Phase 7J compatibility work complete additive
  schema/write and projection-compatibility portions of stages 3, 5, and 6.
- Stage 7 cutover is still blocked: compatibility ranking is healthy, but the
  live V2 lifecycle remains 0 active / 632 candidate / 320 archived.
- Candidate evidence remediation belongs to stage 4 quality/policy comparison.
  Registry matches create a review queue, not confirmed ownership or promotion
  authority. ContextEngine, prompt mutation, and final recall remain later,
  separately approved gates.

## Naming matrix

| Surface | 1.x transition | 2.0 decision point |
| --- | --- | --- |
| Product brand | Add ClawLore in docs/UI | Adopt after conflict review |
| Package/manifest | Keep `scope-recall-openclaw` | Alias or rename in a major release |
| CLI | Keep `scope-recall` and `memory-pro` | Add `clawlore`, deprecate over one major |
| Tools | Keep aliases, reduce discovery | Stable facade with deprecation receipts |
| Config root | Keep current root | Versioned config migration with preview |
| Data directory | Never auto-move | Explicit backup/apply/verify only |
| Source metadata | Preserve historical values | New writes use versioned source tags |
