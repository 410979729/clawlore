# Phase 2E — Projection Convergence Receipts Run (2026-07-11)

## Scope

Truth V2 fixture databases and in-memory projection adapters only. No live
database, vector store, relation graph, plugin, config, hook, ContextEngine, or
Gateway mutation occurred.

## Contract

- Every remember/correct/forget mutation returns a typed projection handle for
  FTS, vector, and relations.
- The handle records the operation and exact outbox ids created in the same SQL
  transaction as the memory event.
- Operator inspection reads those outbox rows and reports each projection as
  `pending`, `retrying`, `processed`, or `missing`.
- Aggregate status becomes `converged` only when all three rows have a
  `processed_at` value.
- Retry attempts expose only a bounded error code, not provider messages or
  memory content.
- Missing or mismatched rows fail closed and never claim convergence.

## Verification

- Projection convergence tests: 2/2 PASS.
- Correction path: pending -> retrying -> converged.
- Forget path: pending -> converged for FTS/vector/relations delete work.
- Missing/mismatched outbox path: reported missing; not converged.
- Full test suite: 130/130 PASS.
- TypeScript typecheck, build, and module-boundary smoke: PASS.
- Vector-repair smoke and golden recall: PASS.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Release gate: PASS; package scan 287 files.

