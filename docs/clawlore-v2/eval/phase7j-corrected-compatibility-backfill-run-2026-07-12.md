# Phase 7J corrected compatibility backfill — 2026-07-12

## Scope and authorization

Joy explicitly approved rollout
`clawlore-v2-compatibility-backfill-20260712-r2` bound to plan digest
`ea045877e59a2b9d5afe726d75224f18b0849a4b3b746ca48175c8b391549697`.
The approval permits only compatibility projection schema/backfill from
persisted `memory_truth.metadata_text`. It preserves V1 fallback and forbids
lifecycle mutation, ContextEngine, prompt mutation, and final recall cutover.

## Fresh snapshot and preview

The prior snapshot exceeded the 3600-second gate, so the authorized refresh
path was used before any live mutation. The new AES-256-GCM snapshot restored
successfully with 952 stable V1 rows, integrity `ok`, zero foreign-key
violations, and no plaintext SQLite, WAL, or SHM residue.

The regenerated read-only preview uses the same rollout id and reproduces the
approved plan digest exactly. It reports V1/V2 952/952, mapping mismatch 0,
existing compatibility projection 0, bootstrap source
`memory_truth.metadata_text`, no raw metadata copy, and all mutation authority
flags false.

## Live apply and independent acceptance

The digest-bound, 0600-approval-bound operator created one rebuildable
`memory_fts_compat_v2` FTS projection with 952 rows. The projection contains
only `item_id`, `content`, and `metadata_text`.

Post-apply evidence:

- V1/V2 truth remains 952/952.
- Canonical `memory_items` changes: 0.
- Lifecycle remains 0 active / 632 candidate / 320 archived.
- Pending projection outbox remains 0.
- Persisted metadata-text mismatches between V1 FTS and compatibility FTS: 0.
- Thirteen text differences remain the known migration-time trim-only
  normalization; they are not metadata or substantive-content drift.
- Six fixed non-sensitive live queries have minimum Top-K overlap 1.0 and
  minimum rank agreement 1.0.
- SQLite integrity is `ok`; foreign-key violations are 0.

Unlike r1, the corrected projection therefore passes real FTS acceptance and
is retained. This does not authorize production recall cutover.

## Regression correction and gates

The first post-apply regression run exposed one fixture-only clock defect: the
second invocation in the repeated-apply test omitted the injected 2026 clock,
so snapshot staleness masked the intended `already exists` assertion. The
minimal fix supplies the same injected clock to the repeated invocation.

Final verification:

- Focused compatibility/preview/control/ranking tests: 10/10 PASS.
- Full plugin tests: 176/176 PASS.
- Typecheck and build: PASS.
- Module-boundary, ranking/control, vector-repair, golden-recall, and release
  gates: PASS.
- Golden recall: 1.0; forbidden violations: 0; prompt-budget exceeded: 0.
- Package dry-run: 384 files.

## Runtime and retained evidence

The OpenClaw configuration hash and Gateway MainPID are unchanged. Gateway is
active/running with `NRestarts=0`; healthz is live; the port remains listening;
warning-or-higher logs since apply are empty. No service restart occurred.

Owner-only evidence is retained under
`workspace/archive/clawlore-phase7j-r2-20260712_211302/`:

- fresh encrypted snapshot and snapshot receipt;
- regenerated read-only preview;
- exact r2 approval;
- apply receipt;
- independent acceptance receipt.

The disposable restore database and its WAL/SHM companions were removed.
Lifecycle promotion remains a no-go at 0 eligible rows. V1 fallback remains in
force; ContextEngine, prompt mutation, and final recall remain disabled.

## Exit cleanup

Generated `node_modules` was removed, no package archive was produced, and no
restore-test SQLite/WAL/SHM file remains. The candidate repository is clean and
`WORKSPACE_LAYOUT_OK` passes. State hygiene still reports the same 68 unrelated
historical outside-workspace findings; this rollout added none.
