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
- Phase 7W completed that bounded sequence. The fresh snapshot restored and
  verified all 982 V1 rows, the exact r4 transaction appended one candidate-only
  V2 row, and V1/V2 plus all four projections converged at 982. Candidate
  replanning exposed that assignment evidence spans two immutable rollout
  generations; the planner now requires the complete, non-overlapping plan/
  acceptance chain and rejects incomplete chains. The regenerated 662-row
  baseline remains 0 eligible, and the new 206-row source-lineage plan is still
  query-only and non-authorizing.
- Phase 7X executed that regenerated 206-row plan only after a byte-identical
  replay and fresh restore-verified encrypted snapshot. The transaction attached
  206 support-only receipts while canonical/lifecycle/verification/address/
  projection/runtime changes stayed 0. Valid receipts now advance to a separate
  `source_lineage_content_review` lane; stale remediation cannot propose them
  again, and content review remains mandatory before any promotion decision.
- A concurrent V1 append again appeared during acceptance. A second fresh
  snapshot and exact one-row r5 delta restored V1/V2 and all four projections
  to 983. The current 663-candidate baseline therefore binds both non-overlapping
  r4 and r5 delta controls, remains 0 eligible / 507 hold / 156 quarantine, and
  grants no lifecycle, ContextEngine, prompt, or final-recall authority.
- Phase 7Y adds the next stage as query-only structural content triage. The
  exact 206-row plan reuses capture-safety, length, and normalized-duplicate
  signals while emitting only hashes and review metadata. Live findings are
  151 operational-trace rejects, 2 safe duplicate rows, and 53 safe unique rows
  awaiting manual semantics; no row is mutation-ready. Rejection, canonical
  selection, rewrite, archive, verification, and lifecycle decisions remain
  separate future controls and cannot be inferred from this plan.
- Phase 7Z isolates the unsafe lane into four query-only operator batches:
  exact-duplicate operational traces, unique oversized traces needing possible
  bounded rewrite, command traces, and tool payloads. The plan revalidates all
  Phase 7Y target digests against live truth and carries no rejection, rewrite,
  archive, verification, lifecycle, or runtime authority. Batch membership is
  prioritization for review, not an automatic disposition.
- Phase 8A adjudicates only the 20 exact-duplicate trace rows after checking
  each normalized group against durable truth. Five groups / 14 rows are
  reversible soft-archive proposals because they duplicate existing knowledge
  or transient service state; three groups / 6 rows contain durable facts and
  remain held for bounded rewrite. The query-only planner accepts unrelated
  live growth only when V1/V2/candidate and all four projections have advanced
  together while active/archived/pending remain unchanged; it never adds that
  growth to the protected target set. A concurrent checkpoint was first
  converged under a fresh encrypted snapshot and exact one-row r6 delta, leaving
  V1/V2/projections at 984 and all mutation authorities disabled. Every rewrite
  or soft archive still needs a separate exact control and acceptance.
- Phase 8B turns the three durable duplicate groups into three bounded rewrite
  representatives plus three post-rewrite dedupe holds. A separate owner-only
  payload carries the proposed prose; the operator plan exposes hashes/actions
  only. Proposals must be capture-safe, non-empty, changed from the source,
  mutually distinct, and absent from the current candidate corpus. Two facts
  are already covered by existing ClawLore truth and one is materially new
  bounded truth. The live plan remains query-only and leaves all six rows
  candidate/unverified. A later exact apply may rewrite only the three
  representatives under a fresh encrypted snapshot; companion archive decisions
  require a new post-rewrite plan.
- Phase 8C performs that exact apply. A new V1-only checkpoint is first
  converged separately under an r7 plan and encrypted snapshot, producing a
  zero-eligible 985-row baseline. A second fresh snapshot then binds an exact
  transaction that creates three new representative revisions while preserving
  candidate/unverified current state, all three companions, address/ACL, V1,
  compatibility/vector/relation projections, outbox, and runtime gates. The
  three old representative revisions become superseded history; this does not
  promote or archive the current items. Post-rewrite controls are regenerated
  from live truth and show 148 unsafe rows, 14 unsafe duplicate rows, 2 safe
  duplicate rows, and 56 semantic-review rows. No earlier content plan is valid
  as later archive authority.
- Phase 8D creates that separate authority only for the three post-rewrite
  companions. The plan binds each unsafe trace to its unchanged lineage receipt
  and to the paired Phase 8C representative rewrite receipt; a fresh encrypted
  snapshot and independent acceptance precede the exact transaction. Three
  archived revisions/sources/supersedes relations/events are created while
  content, verification, address, ACL, V1, all projections, outbox, non-target
  rows, and runtime gates remain unchanged. Archived projections are retained
  for compatibility/audit and are suppressed by lifecycle filtering.
- A dedicated postcheck then proves 3 archived companions, 3 preserved
  representatives, 3 valid disposition receipts, and 0 mismatches. The
  candidate policy is rebased from 665 to 662 without rerunning stale controls:
  0 eligible / 506 hold / 156 quarantine. Rebuilt content quality is 145 unsafe
  / 2 safe duplicate / 56 semantic review, mutation-ready 0. This transaction
  does not authorize the separate 14-row Phase 8E lane or any cutover.
- Phase 8E creates that separate authority for only the 5-group / 14-row
  reversible duplicate lane. Pre-write replay first rejected an action-schema
  mismatch and then live V1/V2 986/985 drift; neither failure opened a write
  transaction. A fresh encrypted snapshot plus exact r8 one-row delta restored
  V1/V2/four projections to 986, and a conservative post-append rebase rebuilt
  the current 663-candidate baseline instead of resurrecting the stale
  pre-Phase8D lifecycle set.
- A second fresh encrypted snapshot then bound the exact duplicate plan,
  independent acceptance, transaction allowlist, and postcheck. Exactly 14
  candidates became archived while content, verification, address, ACL, V1,
  projections, outbox, non-target rows, and runtime gates changed by 0.
  Candidate/archived counts became 649/337 with active 0; integrity is ok and
  FK violations are 0.
- Post-archive plans were regenerated from live truth: 0 eligible / 493 hold /
  156 quarantine; 131 unsafe / 2 safe duplicate / 56 semantic review. The
  unsafe primary lanes are now 7 unique oversized / 109 command / 15 tool and
  the exact-duplicate operational trace lane is 0. Mutation-ready remains 0.
  Phase 8F, Phase 8G, and the Phase 9 cutover-or-no-cutover decision remain
  independently controlled; Phase 8E grants none of their authority.
- Phase 8F-A first refused the stale Phase 8E baseline after the 23:00 nightly
  writer appended 15 V1 rows. A generalized exact-batch acceptance, fresh
  encrypted snapshot, and r9 transaction converged 14 reflection summaries and
  1 operational checkpoint as candidate/unverified/legacy-identity debt.
  V1/V2 and all four projections are now 1001, with 664 candidate / 0 active /
  337 archived and pending outbox 0. Existing canonical/lifecycle/verification/
  evidence state changed by 0.
- All candidate controls were then rebuilt from live truth: 0 eligible / 508
  hold / 156 quarantine; content review remains 131 unsafe / 2 safe duplicate /
  56 semantic review. The new query-only unsafe adjudicator classifies 99 rows
  as reversible soft-archive proposals and 32 as bounded-rewrite holds, with 0
  mutation-ready. The plan exposes hashes/review metadata only and authorizes
  no disposition, verification, lifecycle, hard delete, or runtime change.
- Corpus parity is complete at 1001/1001 with no missing or duplicate mapping.
  Three substantive differences are the intentional Phase 8C durable V2
  rewrites, so shadow/cutover remains blocked along with active/injectable V2
  recall being 0. Phase 8F-B needs new exact controls and a fresh encrypted
  snapshot for any selected archive or rewrite; Phase 8G and Phase 9 remain
  independent.
- Phase 8F-B1 first refused the disposition replay after a new V1 operational
  checkpoint changed live truth to 1002/1001. A separate exact r10 plan, fresh
  restore-verified encrypted snapshot, and one-row transaction converged V1/V2
  and all four projections at 1002. Candidate became 665 while active 0,
  archived 337, pending 0, and existing canonical/lifecycle/verification/
  evidence state remained unchanged.
- Every candidate control was then regenerated from live truth. The new
  query-only disposition plan binds 99 unique reversible archive targets and
  32 unique bounded rewrite designs, with overlap 0, union 131, and
  mutation-ready 0. The rewrite designs separate 7 oversized segmentation
  cases from 25 durable-result extraction cases and require removal of command/
  tool envelopes, capture-safety validation, and corpus deduplication.
- The disposition plan emits hashes and review metadata only. It authorizes no
  soft archive, content rewrite, verification/lifecycle mutation, hard delete,
  ContextEngine, prompt mutation, or final recall. Phase 8F-B2 requires a new
  fresh snapshot and independent exact acceptance for only the 99-row archive
  lane; the 32 designs need their own payload-bearing proposal and transaction.
- Phase 8F-B2 first refused that replay after another V1 operational checkpoint
  changed live truth to 1003/1002. A separate exact r11 plan and fresh,
  restore-verified encrypted snapshot converged only that row and restored
  V1/V2 plus all four projections to 1003. Candidate became 666 while active 0,
  archived 337, pending 0, and existing canonical/lifecycle/verification/
  evidence state remained unchanged.
- All controls were regenerated before mutation. Independent acceptance matched
  a new exact 99-archive / 32-rewrite split with overlap 0 and plan digest
  `504faad2...c3ecb`. A second fresh encrypted snapshot then bound the archive
  transaction. Exactly 99 candidates became archived; the 32 rewrite targets,
  non-target content/verification/address/ACL/projections/outbox, V1, and
  runtime gates changed by 0. Postcheck proved 99 receipts, supersedes
  relations, lifecycle events, and projection bindings with 0 mismatches.
- The new lifecycle baseline is 567 candidate / 0 active / 436 archived with
  V1/V2/FTS/vector 1003 and integrity/FK healthy. Rebuilt controls are 0
  eligible / 411 hold / 156 quarantine and 32 unsafe / 2 safe duplicate / 56
  semantic review. The unsafe archive lane is now empty; Phase 8F-B3 requires
  separate payload-bearing authority for the 32 rewrite holds. Phase 8G and
  Phase 9 remain independent.
- Phase 8F-B3A adds that payload-bearing proposal boundary without creating a
  live payload or write authority. Exact coverage is fixed at 7 oversized holds
  with one-to-four bounded outputs and 25 semantic holds with exactly one. The
  owner-only payload carries proposed prose; the redacted plan carries only
  hashes, lengths, evidence digests, and counts, and independent acceptance
  recomputes capture safety, corpus dedupe, source lineage, target revision, and
  the B1/B2 control chain. Live inspection found V1/V2 1005/1003, so the planner
  correctly refuses the stale baseline. Phase 8F-B3B must first converge the
  exact two-row append under a fresh encrypted snapshot, rebuild every control,
  and only then create the private payload and a separate exact rewrite
  transaction. No content, lifecycle, verification, projection, runtime, or
  cutover mutation occurred in B3A.
- Phase 8F-B3B converges the exact r12 two-row append under a fresh encrypted
  snapshot, then binds a second snapshot to one final bounded output per 32
  rewrite targets. The transaction creates 32 new current revisions/sources/
  supersedes relations/events and updates 32 current-FTS rows. Independent
  postcheck proves zero mismatch while V1, lifecycle, verification, address,
  ACL, compatibility/vector/relation projections, outbox, non-target rows, and
  runtime gates remain unchanged.
- Phase 8G closes the post-rewrite state transition with a receipt-aware,
  query-only plan. The 32 successfully rewritten rows are removed from generic
  semantic review only after their proposal/apply/postcheck chain is valid.
  Authenticated review of the exact remaining 2 safe duplicates + 56 semantic
  rows proposes 24 reversible archives and retains 34 candidates for evidence;
  no rewrite hold or mutation-ready row remains.
- Phase 9 records explicit `no_cutover`. V1/V2 and all projections are 1005,
  but active/injectable V2 rows and eligible promotions are 0, verification
  debt remains, 24 archive proposals are unapplied, current content differs in
  47 mapped rows, and runtime implements only disabled/read-only shadow modes.
  V1 fallback remains enabled; ContextEngine, prompt mutation, lifecycle
  promotion, and final recall remain disabled.

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
