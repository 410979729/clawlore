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
7. Cut over only after quality gates, an exact bounded plan, and a verified
   rollback point; no separate human approval artifact is part of execution.
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
  authority. ContextEngine, prompt mutation, and final recall remain separate
  later changes, outside evidence-assignment and migration executors.
- Phase 7L remains in stage 4: it turns the review queue into an exact,
  non-authorizing evidence-assignment plan. Only 90 registry-resolved rows are
  proposed for evidence writes; every one remains candidate with its current
  verification. The other 542 rows are explicitly held or quarantined.
- Applying that plan is not stage 7 cutover and requires a fresh encrypted
  snapshot plus an exact-plan digest. Evidence assignment cannot authorize
  lifecycle, ContextEngine, prompt mutation, or final recall.
- Phase 7M consumed that exact approval and wrote registry-resolved evidence to
  only the planned 76 direct-principal and 14 conversation-boundary source
  rows. All 632 candidates preserved lifecycle and verification; the other 542
  rows and every runtime/cutover control were unchanged. This remains stage 4.
- The next permissible step is a new read-only candidate-policy preview that
  explicitly understands the new evidence shape. It cannot infer lifecycle
  authority from a successful evidence write.
- Phase 7N completed that read-only preview. All 90 assigned payloads match the
  approved exact plan, but the result remains 0 eligible / 476 hold / 156
  quarantine because registry resolution did not change address, verification,
  operator review, or source-receipt state. No lifecycle rollout is selectable.
- Legacy V1 continued receiving writes after the additive migration and is now
  979 rows while V2 remains 952. The 27 append-only, unmirrored V1 rows do not
  invalidate the exact 632-row candidate review, but they are a separate stage
  4/5 parity blocker and prohibit final recall cutover until a new migration/
  projection plan handles them under its own exact bounded plan.
- Phase 7O mapped those 27 rows in a new non-authorizing delta preview. Every
  row is a reflection summary with unresolved legacy identity and unverified
  evidence, so the only safe proposed lifecycle is candidate (0 active / 27
  candidate / 0 archived). Existing V2 candidate state remains out of scope.
- Applying the delta would add Truth, compatibility FTS, current FTS, vector
  fallback, relation projection, and processed outbox receipts atomically. It
  requires a fresh encrypted snapshot and a reproduced exact plan digest;
  the read-only plan cannot authorize a write or final recall cutover.
- Phase 7P consumed the exact 27-row approval only as a pre-apply gate. The
  mandatory live replan found V1/V2 980/952 and 28 delta rows (27 reflection
  summaries plus 1 operational checkpoint), changing the digest to
  `6f1e6ac9...421d35`. The old approval therefore failed closed before snapshot
  or write. The new 28-row plan is isolated under rollout r2, remains
  non-authorizing, and all rows remain candidate/unverified with legacy-identity debt.
- A later delta apply now has an executable transaction path, but it may run
  only after a fresh encrypted snapshot and a reproduced exact plan for
  the 28-row digest. Existing V2 canonical/lifecycle/verification/evidence,
  V1 fallback, ContextEngine, prompt mutation, and final recall stay immutable.
- Phase 7Q consumed the exact r2 approval only after reproducing the authorized
  digest and verifying a fresh encrypted snapshot. It appended exactly 28
  candidate/unverified rows and converged compatibility/current FTS/vector/
  relation projections plus 84 processed outbox receipts. V1/V2 are now
  980/980 and existing canonical/lifecycle/verification/evidence changes are 0.
- This closes the known append-only parity blocker but does not advance stage 7
  cutover: lifecycle is still 0 active / 660 candidate / 320 archived. The next
  permissible action is a new read-only 660-candidate policy/evidence baseline;
  the delta executor cannot change lifecycle, ContextEngine, prompt, or final recall.
- Phase 7R generated that new stage-4 baseline. It preserves the exact 632-row
  Phase 7L/7M assignment state and admits the 28 Phase 7Q rows only by binding
  the owner-only delta acceptance and validating their candidate/unverified/
  legacy-identity-debt shape plus all four 980-row projections.
- The resulting 660-row policy plan is 0 eligible / 504 hold / 156 quarantine,
  automatic promotion 0. It authorizes no mutation and gives no reason to open
  a lifecycle write path. The next plan-led step is read-only remediation of
  the 504 hold and 156 quarantine lanes; any later evidence write needs a fresh
  encrypted snapshot and a reproduced exact bounded plan.
- Phase 7S preserves that 504/156 policy split while refining the 504 holds into
  77 assignment-review and 427 evidence-review rows. Only one new registry-
  direct row is proposed for evidence assignment; the exact plan keeps the
  other 659 rows unchanged and grants no write/lifecycle/runtime authority.
- Phase 7T removes the repeated human approval files from the executable
  contract. Runtime shadow, migration, compatibility, append-delta, evidence
  assignment, and promotion planning now rely on machine-enforced readiness,
  exact plan digests, drift rejection, fresh encrypted snapshots, transactional
  scope checks, rollback evidence, and projection verification. Historical
  approval artifacts remain immutable audit evidence only. Hard-delete
  confirmation remains because it protects irreversible deletion.
- Phase 7U remains in stage 4 and converts the 206 derived-system evidence
  holds into an exact, query-only source-lineage receipt plan. All 206 are
  reflection summaries with an exact legacy source, current V2 source, and
  same-revision migration event bound to the rollout id; 0 have incomplete
  lineage. Historical `operator:approved-*` event actor strings are immutable
  audit data, not restored approval controls.
- The Phase 7U plan authorizes no write and does not claim content quality. A
  later exact-plan apply may attach source-lineage receipts only after a fresh
  encrypted snapshot and drift replay, while preserving candidate/unverified
  state. Operator content review remains a separate prerequisite for any
  lifecycle change, ContextEngine, prompt mutation, or final recall.
- Phase 7V adds that exact-plan apply path without executing it live. The
  executor replays the complete plan before write, rechecks per-row state,
  source, and migration-event digests inside one transaction, writes only a
  source-lineage receipt, and independently proves non-target/canonical/event/
  projection state stayed unchanged.
- The first live replay correctly failed closed because V1 appended one
  `session-pressure-guard` operational checkpoint after Phase 7U, producing
  V1/V2 982/981. No snapshot or write followed the mismatch.
- A separate query-only r4 delta plan covers exactly that one row as
  candidate/unverified/legacy-identity debt. It must be replayed under a fresh
  encrypted snapshot before any bounded delta apply; afterward the candidate,
  remediation, and source-lineage plans must be regenerated. The old 206-row
  digest cannot be reused across this drift.

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
