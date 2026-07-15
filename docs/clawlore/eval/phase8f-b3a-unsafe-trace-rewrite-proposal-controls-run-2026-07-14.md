# Phase 8F-B3A unsafe trace rewrite proposal controls — 2026-07-14

## Scope and result

Phase 8F-B3A added the non-mutating control layer required before any of the 32
remaining unsafe trace candidates can be rewritten:

- exact coverage is fixed at 7 oversized segmentation holds plus 25 semantic
  durable-result extraction holds;
- an owner-only payload may carry proposed memory prose, while the public plan
  carries only hashes, lengths, evidence digests, counts, and review metadata;
- oversized rows accept one to four bounded outputs and semantic rows accept
  exactly one, so the payload can propose 32 to 53 durable rows without granting
  authority to materialize any of them;
- capture safety, corpus collision, mutual duplication, target revision, source
  lineage, category, B1 disposition, B2 apply, and B2 postcheck bindings all fail
  closed;
- independent acceptance recomputes the complete proposal from live SQL truth
  and rejects proposed-content or raw trace leakage in the redacted plan.

This phase created no live payload, acceptance receipt, encrypted snapshot, or
rewrite transaction. It did not read or change the 32 private memory bodies.

## Control boundary

The proposal is deliberately non-authorizing:

- `authorizesContentRewrite=false`;
- `authorizesSoftArchive=false`;
- `authorizesHardDelete=false`;
- `authorizesLifecycleMutation=false`;
- `authorizesVerificationMutation=false`;
- `authorizesContextEngine=false`;
- `authorizesPromptMutation=false`;
- `authorizesFinalRecall=false`;
- `requiresFreshEncryptedSnapshot=true`;
- `requiresSeparateExactApply=true`.

The planner accepts only a fully converged append-only extension of the Phase
8F-B2 postcheck source. V1-only growth is rejected before a proposal receipt can
be created.

## Live drift found

Read-only verification found that live truth had advanced after Phase 8F-B2:

- V1 SQL truth: 1005;
- V2 / compatibility FTS / current FTS / vector / relation: 1003 each;
- lifecycle: 567 candidate / 0 active / 436 archived;
- pending outbox: 0;
- SQLite integrity: ok; foreign-key violations: 0.

The exact two-row V1-only append means the old 1003/1003 baseline is stale. The
new planner correctly refuses this 1005/1003 state. Phase 8F-B3B must first
converge only those two appended rows under a fresh encrypted snapshot and an
exact append-delta control before any private rewrite payload is produced.

## Verification

- focused B1/B2/durable/B3A regression: 18/18 PASS;
- new B3A tests: 5/5 PASS;
- full plugin tests: 247/247 PASS;
- TypeScript typecheck and build: PASS;
- module-boundary tests: 2/2 PASS;
- vector-repair smoke: PASS;
- golden recall / top-K: 1.0 / 1.0;
- forbidden-scope violations: 0;
- release gate: PASS;
- closing npm package scan: 529 files;
- Gateway: active/running, PID 328735, NRestarts 1, healthz live.

Code commit: `365a7c0` (`feat(clawlore): add unsafe trace rewrite proposal controls`).

The first full-test and vector-smoke attempts were invalid environment runs
because the cleaned project intentionally had no local `node_modules`, so
LanceDB could not be resolved. Both were rerun with a temporary link to the
already-installed workspace dependency tree; the valid runs passed and the
link was removed afterward. A debug log created by one mistaken npm script name
was also removed.

## Evidence, cleanup, and next boundary

Committed source surfaces for this round are the application planner, live
proposal/acceptance operator, two CLI wrappers, compiled JavaScript, package
scripts, and the focused test file. No live extension, OpenClaw config, Gateway
process, runtime flag, database row, snapshot, payload, or owner-only control
was changed.

Phase 8F-B3B remains a separate live stage:

1. reproduce the exact two-row V1 append delta and converge V1/V2 under a fresh
   encrypted snapshot;
2. rebuild all current candidate, quality, capture-safety, and rewrite controls;
3. create and independently accept the owner-only 32-row payload without
   leaking proposed or original memory prose into public controls;
4. design the exact materialization semantics for one-to-four oversized
   outputs, then take another fresh encrypted snapshot before any transaction;
5. independently postcheck target revisions, non-target state, projections,
   outbox, integrity, and all runtime gates.

Phase 8G still owns the 2 safe duplicates and 56 semantic-review rows. Phase 9
remains the explicit cutover-or-no-cutover decision.
