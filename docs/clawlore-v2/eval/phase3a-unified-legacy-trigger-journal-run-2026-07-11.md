# Phase 3A — Unified Legacy Trigger Journal Run (2026-07-11)

## Scope

Pure legacy-trigger adapters, one in-memory candidate journal, and a fixture
Truth V2 database. Existing live auto-capture, reflection, digest,
task-experience hooks, plugin config, and data were not changed.

## Contract

- Auto-capture, reflection, digest, and task-experience adapters emit the same
  `TurnEnvelopeV2` contract.
- Event ids are deterministic from trigger, Memory Address V2, and source id.
- Missing source/run/episode provenance fails closed.
- Adapters do not receive a store and cannot persist directly.
- All four event types enter one `DistillationJournalV2` and the same safety,
  admission, dedupe, Truth V2, and outbox path.
- Automatic legacy triggers force candidate lifecycle. A task episode with
  tool receipts may carry `tool_verified` evidence but does not become active
  from one successful run.
- Journal payload hashes include trigger and source ids for reproducible replay.

## Verification

- Unified legacy-trigger tests: 2/2 PASS.
- Four adapters -> four deterministic events -> one candidate journal.
- Four admitted records remain candidate; three unverified and one
  tool-verified task candidate.
- Idempotent replay writes no additional memory.
- Full test suite: 132/132 PASS.
- TypeScript typecheck, build, and module-boundary smoke: PASS.
- Vector-repair smoke and golden recall: PASS.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Release gate: PASS; package scan 291 files.

