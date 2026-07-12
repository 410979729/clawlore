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
- Phase 7L remains in stage 4: it turns the review queue into an exact,
  non-authorizing evidence-assignment plan. Only 90 registry-resolved rows are
  proposed for evidence writes; every one remains candidate with its current
  verification. The other 542 rows are explicitly held or quarantined.
- Applying that plan is not stage 7 cutover and requires a fresh encrypted
  snapshot plus an exact-plan approval. Evidence assignment cannot authorize
  lifecycle, ContextEngine, prompt mutation, or final recall.
- Phase 7M consumed that exact approval and wrote registry-resolved evidence to
  only the planned 76 direct-principal and 14 conversation-boundary source
  rows. All 632 candidates preserved lifecycle and verification; the other 542
  rows and every runtime/cutover control were unchanged. This remains stage 4.
- The next permissible step is a new read-only candidate-policy preview that
  explicitly understands the new evidence shape. It cannot reuse Phase 7M
  approval or infer lifecycle authority from a successful evidence write.
- Phase 7N completed that read-only preview. All 90 assigned payloads match the
  approved exact plan, but the result remains 0 eligible / 476 hold / 156
  quarantine because registry resolution did not change address, verification,
  operator review, or source-receipt state. No lifecycle rollout is selectable.
- Legacy V1 continued receiving writes after the additive migration and is now
  979 rows while V2 remains 952. The 27 append-only, unmirrored V1 rows do not
  invalidate the exact 632-row candidate review, but they are a separate stage
  4/5 parity blocker and prohibit final recall cutover until a new migration/
  projection plan handles them under its own approval.
- Phase 7O mapped those 27 rows in a new non-authorizing delta preview. Every
  row is a reflection summary with unresolved legacy identity and unverified
  evidence, so the only safe proposed lifecycle is candidate (0 active / 27
  candidate / 0 archived). Existing V2 candidate state remains out of scope.
- Applying the delta would add Truth, compatibility FTS, current FTS, vector
  fallback, relation projection, and processed outbox receipts atomically. It
  requires a fresh encrypted snapshot and a separate exact-digest approval;
  the read-only plan cannot authorize a write or final recall cutover.

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
