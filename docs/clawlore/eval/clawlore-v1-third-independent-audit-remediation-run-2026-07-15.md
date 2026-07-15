# ClawLore v1 third independent-audit remediation run — 2026-07-15

## Decision

The third independent re-audit findings were accepted as release blockers and
fixed in the source candidate. The candidate remains **not authorized for
publication, deployment, or V2 cutover** until Tianxuan independently re-audits
the final clean commit.

## Remediated findings

### SQL authority outage

- Existing SQL-truth initialization failures now stop store initialization with
  stable code `CLAWLORE_SQL_TRUTH_UNAVAILABLE`.
- Corrupt, permission-denied, directory-path, and incompatible-schema cases no
  longer fall back to LanceDB or sqlite-bruteforce companions.
- Doctor and diagnostics expose a redacted recovery signal instead of claiming
  a safe vector-only degradation.

### SQL truth, FTS, and projection intent

- Truth upsert/delete and FTS replacement/deletion run in one SQLite
  transaction/savepoint.
- Durable vector repair intent is committed with the truth/FTS boundary before
  companion work begins.
- Supersede, bulk delete, and reconciliation reuse internal statements under
  the caller's transaction instead of nesting independent `BEGIN` blocks.
- Fault injection proves that FTS or intent failures leave truth, FTS, and
  outbox counts unchanged; retry does not create an orphaned first write.

### Experience Kernel durability

- Playbook creation atomically commits the durable row, FTS row, and initial
  version receipt.
- Promotion/review atomically commits status and `superseded_by` with the
  version receipt.
- Receipts are built from the post-change durable row, not the stale pre-change
  object.
- Feedback run completion and playbook counters share one transaction.

### Availability and release-process hardening

- Vector retrieval exponentially expands a bounded scan up to 5,000 candidates
  until it finds enough SQL-valid rows or exhausts the companion result set.
- SQL FTS failures explicitly return a fail-closed empty result with a stable,
  redacted diagnostic; logs no longer claim a companion fallback.
- Model-visible tool failures use stable codes and summaries while raw details
  remain only in redacted operator diagnostics.
- The source gate requires an intact lockfile dependency tree before product
  tests and pins the advisory audit to `https://registry.npmjs.org`; missing
  dependencies and audit endpoint/transport failures are red gates.

## Regression evidence

Focused coverage was added for:

- corrupt, unreadable, directory, and incompatible SQL-truth authority stores;
- FTS insert/delete and vector-intent rollback;
- Experience version, FTS, and feedback-counter rollback plus post-state
  receipt equality;
- 250 stale high-ranked companion rows preceding one SQL-valid row;
- missing dependency and advisory endpoint failures;
- canary private paths, token-shaped strings, and user text in tool errors.

The complete source gate passed 313/313 tests, typecheck, build, vector repair,
the 124-case deterministic recall matrix, the 200,000-row SQLite FTS baseline,
SBOM generation, official-registry production dependency audit, and the
182-file extracted package content scan.

## Truth and rollout boundary

- Live remains `scope-recall-openclaw@1.1.0`; this candidate was not copied into
  the live extension directory.
- No live memory/config/plugin identity/V2 data-plane change is part of this
  source remediation.
- V2 still has zero active rows, so cutover remains fail-closed regardless of
  source-gate success.
- The 124-case matrix and 200,000-row test are deterministic engineering
  evidence, not an independent human relevance or commercial-scale evaluation.
- This project has no `TODO-enterprise-memory-core.md`; the maintained truth set
  is this report plus `docs/clawlore/project-handoff.md` and the workspace daily
  record. No empty placeholder was created.

## Next gate

Record the final clean commit and runtime digest, reproduce the gate from a
clean lockfile install, run isolated OpenClaw inspect/doctor/CLI smoke, and give
that exact evidence set to Tianxuan. Only an accepted re-audit may authorize a
repository push; live rollout remains a separate backup-backed decision.
