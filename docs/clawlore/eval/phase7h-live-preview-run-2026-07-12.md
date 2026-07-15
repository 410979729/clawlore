# Phase 7H fresh snapshot and independent live previews — 2026-07-12

## Scope

Joy explicitly approved rollout `clawlore-v2-phase7g-preview-20260712-r1`
for one fresh encrypted snapshot and two read-only live previews. The approval
forbade compatibility projection creation, lifecycle changes, ContextEngine,
prompt mutation, and final recall cutover. This round stayed within that
boundary.

## Implementation

- Added a snapshot-bound live preview operator and CLI.
- The operator requires an owner-only encrypted archive and receipt, verifies
  the archive checksum, rechecks the live V1 logical digest, opens SQLite
  read-only with `query_only`, and verifies that V1 truth stayed stable.
- The compatibility plan binds all V1/V2 mappings, the absent destination
  projection, the exact historical eight-field allowlist, and a row-manifest
  digest without emitting memory content or raw metadata.
- The candidate plan covers every current candidate and emits only hashed item
  ids, dispositions, and reason codes. Automatic promotion remains zero.
- Compatibility backfill and candidate promotion retain distinct rollout ids,
  plan digests, and approvals. The resulting control receipt authorizes
  neither action and cannot enable ContextEngine, prompt mutation, or final
  recall.
- Implementation commit: `fa7276f`.

## Fresh encrypted snapshot

- AES-256-GCM archive and receipt mode: 0600.
- Source truth: 952 rows, stable during backup and restore verification.
- SQLite integrity: ok; foreign-key violations: 0.
- Archive restore matched the source schema and logical truth digests.
- Restore-test SQLite, WAL, and SHM files were removed; residue count is 0.
- Existing persistent key id was reused; key material was not logged, copied,
  or written to Markdown.

Artifacts:

- `workspace/archive/clawlore-phase7g-preview-20260712_200853/legacy-live-fresh-20260712_200853.clawlore2`
- `workspace/archive/clawlore-phase7g-preview-20260712_200853/legacy-live-fresh-20260712_200853.receipt.json`
- `workspace/archive/clawlore-phase7g-preview-20260712_200853/phase7g-live-preview-final-20260712_200853.json`

## Live preview results

Compatibility backfill plan:

- V1/V2 rows: 952/952.
- Missing or extra mappings: 0.
- Existing `memory_fts_compat_v2` projection rows/objects: 0.
- Expected projection rows: 952.
- Raw legacy metadata copied: false.
- Indexed fields: `l0_abstract`, `l1_overview`, `l2_content`, `keywords`,
  `entities`, `tags`, `category`, and `tier`.
- Plan digest: `5614ec9e30b9092dc65ef91b306b3254881723f48194bdb47167bdbee8089d8a`.

Candidate promotion plan:

- Exact candidate coverage: 632/632.
- Eligible for a later operator promotion batch: 0.
- Hold candidate: 476.
- Quarantine: 156.
- Preserve archived in actionable batch: 0.
- Automatic promotion: 0.
- Plan digest: `d93c590f6c1d4437d9a3a5b1da1dc86d5793b92fbc59e7648030fdbd4ae1351b`.

Control result:

- Status: `ready_for_separate_approvals`; blockers: 0.
- Compatibility rollout id:
  `clawlore-v2-compatibility-backfill-20260712-r1`.
- Candidate rollout id: `clawlore-v2-candidate-promotion-20260712-r1`.
- Compatibility backfill authority: false.
- Candidate promotion authority: false.
- ContextEngine / prompt mutation / final recall authority: false / false / false.

The candidate plan is therefore a no-go for lifecycle mutation. There is no
eligible promotion batch to approve. Compatibility backfill may be considered
separately under its exact rollout id and plan digest, but this preview does not
authorize it.

## Verification

- Focused ranking/control/live-preview tests: 8/8 PASS.
- Full plugin tests: 174/174 PASS.
- Typecheck and build: PASS.
- Module-boundary tests: 2/2 PASS.
- Vector-repair smoke: PASS.
- Golden recall: recall 1.0; forbidden violations 0; prompt budget exceeded 0.
- Release gate: PASS; package scan 378 files.
- Live baseline: Gateway active/running, `NRestarts=0`, healthz live.
- Live database: V1/V2 952/952, 0 active / 632 candidate / 320 archived,
  pending outbox 0, integrity ok, foreign-key violations 0, and no compatibility
  projection object.

## Cleanup and remaining gates

The superseded first preview receipt, generated dependency tree, and any
restore-test residue were removed during final cleanup. The fresh encrypted
archive, its 0600 receipt, and the final 0600 preview receipt are retained as
rollback/audit evidence. No live database row, schema, configuration, plugin,
prompt, ContextEngine selection, final recall route, or service process was
changed.

Final exit checks: candidate repository clean, `WORKSPACE_LAYOUT_OK`, Gateway
active/running with `NRestarts=0`, healthz live, port 19021 listening, and no
warning-or-higher service entries during the round. State hygiene remains the
same 68 unrelated historical outside-workspace findings; this round added none.

Remaining independent gate: exact-digest approval for the compatibility
projection backfill, if Joy chooses it. Candidate promotion remains blocked by
zero eligible rows. ContextEngine, prompt mutation, and final recall remain
later independent gates.
