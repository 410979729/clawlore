# Phase 7F fixture ranking and promotion policy run — 2026-07-12

## Scope

This round implemented the next safe slice after the live Phase 7E no-cutover
decision. All ranking work used synthetic fixtures. Candidate promotion is a
pure read-only plan. The live database, extension, configuration, runtime
registration, prompt, ContextEngine, final recall, and Gateway process were not
changed.

## Implementation

- Added a fixture FTS compatibility evaluator with three lanes: V1
  `content + metadata_text`, current V2 `content + category`, and proposed V2
  compatibility `content + metadata_text`.
- Restricted legacy auxiliary search projection to the existing eight-field
  allowlist and ignored arbitrary metadata such as sender/session/secret keys.
- Kept `memory_items` as canonical truth; the compatibility table is explicitly
  rebuildable and requires a separately approved one-time backfill from the
  already-derived V1 `metadata_text` projection.
- Added an address-bound candidate promotion policy for private,
  conversation, project, and broad scopes. Principal/conversation/project
  evidence must match the proposed V2 address.
- Kept automatic promotion at zero. Eligible rows are only eligible for a later
  exact-digest operator approval; hold, quarantine, and archived dispositions
  remain non-injectable.
- Added a synthetic fixture, three focused tests, one machine-readable smoke,
  and the policy document.
- Implementation commit: `936c1d3`.

## Fixture evidence

- Current V2 native FTS minimum Top-K overlap: `0.0` in the intentionally
  divergent fixture.
- Compatibility projection minimum Top-K overlap: `1.0`.
- Compatibility projection minimum rank agreement: `1.0`.
- Three arbitrary metadata fields were ignored; raw metadata was not copied and
  fixture content was not emitted in the report.
- Promotion fixture: 3 eligible for separate operator review, 2 held as
  candidates, 2 quarantined, and 1 preserved archived.
- Automatic promotion: 0; live mutation authority: false.

## Verification

- Focused Phase 7F tests: 3/3 PASS.
- Phase 7E + Phase 7F focused regression: 5/5 PASS.
- Full plugin tests: 169/169 PASS.
- Typecheck and build: PASS.
- Module-boundary tests: 2/2 PASS.
- Vector-repair smoke: PASS.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Release gate: PASS; final package scan 369 files.
- Exit live check: Gateway active/running, NRestarts 0, port 19021 healthz
  live, and warning-or-higher unit log empty for the round.
- Live data remained V1/V2 952/952, lifecycle 0 active / 632 candidate / 320
  archived, all three V2 projections 952, outbox pending 0, integrity ok,
  foreign-key violations 0, and compatibility projection absent.

## Cleanup

Generated `node_modules` was removed, the candidate repository is clean, and
the workspace layout audit reports `WORKSPACE_LAYOUT_OK`. The pre-existing
ignored package lock was retained. State hygiene still reports the same 68
outside-workspace historical findings (root config backups, session reset/
deleted/bak residue, and foreign plugin-cache canonical docs); this round did
not create or modify them.

## Decision and remaining gates

The fixture design is ready for a later live preview, but no live action is
authorized. `cutoverReady` remains false. A future compatibility backfill and a
future candidate-promotion batch each require a fresh encrypted snapshot,
read-only live plan, exact digest, rollback/convergence evidence, and separate
operator approval. ContextEngine, prompt mutation, and final recall remain
disabled.
