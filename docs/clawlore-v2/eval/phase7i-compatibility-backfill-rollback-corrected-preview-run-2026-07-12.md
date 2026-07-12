# Phase 7I compatibility backfill rollback and corrected preview — 2026-07-12

## Scope and authorization

Joy explicitly approved rollout
`clawlore-v2-compatibility-backfill-20260712-r1` bound to plan digest
`5614ec9e30b9092dc65ef91b306b3254881723f48194bdb47167bdbee8089d8a`.
The approval allowed only the compatibility projection schema/backfill with V1
fallback and forbade lifecycle changes, ContextEngine, prompt mutation, and
final recall cutover.

## Initial apply and failed acceptance

Commit `3f785c7` added a digest-bound, approval-bound transactional executor and
two focused regression tests. The executor applied one rebuildable
`memory_fts_compat_v2` projection with 952 rows. Its apply receipt proved:

- V1/V2 remained 952/952.
- Canonical `memory_items` changed by 0.
- Lifecycle rows changed by 0; active/candidate/archived remained 0/632/320.
- Pending outbox changed by 0 and remained 0.
- The projection contained only `item_id`, `content`, and `metadata_text`.
- Runtime remained V1 fallback with lifecycle mutation, ContextEngine, prompt
  mutation, and final recall disabled.

Independent live FTS acceptance then found that the projection did not restore
the intended V1 ranking. Across six fixed, non-sensitive probes, minimum Top-K
overlap was 0.6 and minimum rank agreement was 0.433333. The apply was therefore
not accepted as complete.

## Root cause and rollback

The Phase 7F design named `memory_truth.metadata_text` as the compatibility
bootstrap source. The Phase 7H preview implementation instead recomputed the
eight-field projection from raw `memory_truth.metadata`. Historical rows do not
always recompute byte-for-byte to their persisted V1 search companion:

- 952 mappings were complete.
- V1 FTS and `memory_truth.metadata_text` differed on 0 rows.
- The r1 projection differed from persisted V1 `metadata_text` on 251 rows.
- V1 metadata search text totaled 1,889,849 characters; r1 projected text
  totaled 1,309,791 characters.

The projection was immediately dropped in one transaction. Rollback evidence
shows no compatibility object remains, V1/V2 are still 952/952, lifecycle is
still 0/632/320, pending outbox is 0, integrity is ok, and foreign-key
violations are 0. The failed apply, approval, and rollback receipts remain 0600
audit evidence. No service restart or configuration change occurred.

## Corrected plan

The plan and executor now bind the bootstrap source explicitly to
`memory_truth.metadata_text`. Raw metadata is still not copied, and the
historical eight-field allowlist contract remains explicit. Tests include a
historical-drift fixture proving raw metadata changes cannot silently alter the
approved compatibility projection.

Corrected read-only preview:

- Rollout id: `clawlore-v2-compatibility-backfill-20260712-r2`.
- Plan digest:
  `ea045877e59a2b9d5afe726d75224f18b0849a4b3b746ca48175c8b391549697`.
- Bootstrap source: `memory_truth.metadata_text`.
- V1/V2: 952/952; mapping mismatch 0; existing projection 0.
- Candidate plan remains 0 eligible, 476 hold, 156 quarantine; automatic
  promotion 0.
- All mutation authorities remain false.

A temporary, connection-local FTS projection built from the corrected source
restored minimum Top-K overlap and rank agreement to 1.0 across the same six
live probes. The temporary table was not persisted.

## Verification and remaining gate

- Focused compatibility/preview/control tests: 7/7 PASS.
- Full plugin tests: 176/176 PASS.
- Typecheck, build, module boundaries, ranking/control smokes, vector repair,
  golden recall, and release gate: PASS.
- Golden recall: 1.0; forbidden violations 0; prompt budget exceeded 0.
- Package dry-run: 383 files.
- Gateway remained active/running with `NRestarts=0`; healthz live; recent
  warning journal empty.

The r1 authorization is consumed and cannot authorize the corrected r2 plan.
No compatibility projection currently exists. A new exact-digest approval is
required before r2 may write live data. Lifecycle mutation, ContextEngine,
prompt mutation, and final recall remain forbidden.

Artifacts:

- `workspace/archive/clawlore-phase7g-preview-20260712_200853/compatibility-backfill-apply-receipt-20260712.json`
- `workspace/archive/clawlore-phase7g-preview-20260712_200853/compatibility-backfill-rollback-receipt-20260712.json`
- `workspace/archive/clawlore-phase7g-preview-20260712_200853/phase7g-live-preview-corrected-20260712_204913.json`
