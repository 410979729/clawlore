# Phase 7M live evidence assignment — 2026-07-12

## Plan position and authorization boundary

This round remains in migration stage 4. Joy approved rollout
`clawlore-v2-evidence-assignment-20260712-r1`, bound to exact plan digest
`0f432fad09130287181fc811e8a61cc80f42ed6d10ace7d2d3c0077b9aec4e1c`.
The approval permits a fresh encrypted snapshot and evidence writes for only
the planned 76 direct-principal and 14 conversation-boundary candidates.

The approval does not authorize lifecycle or verification changes, manual
principal assignment, external source-receipt writes, quarantine changes,
ContextEngine, prompt mutation, or final recall.

## Fail-closed implementation

Commit `b99184b` adds an exact-plan live apply operator and two focused tests.
The operator:

- validates the owner-only plan, approval, snapshot archive, and snapshot
  receipt before opening a write transaction;
- recomputes the current 632-row workbench and requires every target row,
  current-state digest, resolver, and resolver-evidence digest to match the
  approved plan;
- tolerates only unrelated additions to the live sessions registry; any
  target-scoped registry change rejects the whole rollout before mutation;
- updates only the current `memory_sources.evidence_json` row for each exact
  target and rejects duplicate or multi-source assignments;
- verifies inside the transaction that canonical items, lifecycle,
  verification, address, outbox, compatibility projection, and non-target
  evidence are unchanged before commit.

## Fresh encrypted snapshot

The fresh AES-256-GCM archive and receipt are owner-only. Restore verification
passed with 952 `memory_truth` rows, SQLite integrity `ok`, zero foreign-key
violations, a stable logical truth digest, and no plaintext/WAL/SHM restore
residue.

Archive directory:

`workspace/archive/clawlore-phase7m-evidence-assignment-20260712_224100/`

The encrypted archive is retained as rollback evidence. The persistent key
remains in the existing 0600 SecretRef area and is not copied into docs or
receipts.

## Live apply and independent verification

The exact rollout applied at `2026-07-12T14:43:05.692Z`:

- 90 evidence rows written;
- 76 `direct-principal` assignments;
- 14 `conversation-boundary` assignments;
- manual, external-source-receipt, quarantine, and non-target evidence rows
  changed: 0;
- payload mismatch, unexpected assignment, and planned-state mismatch: 0.

Live truth after apply remains:

- V1/V2: 952/952;
- lifecycle: 0 active / 632 candidate / 320 archived;
- compatibility projection: 952;
- pending outbox: 0;
- SQLite integrity: `ok`; foreign-key violations: 0.

The acceptance receipt is:

`workspace/archive/clawlore-phase7m-evidence-assignment-20260712_224100/evidence-assignment-acceptance-20260712.json`

It is mode 0600. `openclaw.json` was unchanged. Gateway MainPID remained
4169210, `NRestarts=0`, healthz returned live, port 19021 remained listening,
and warning-or-higher unit logs since the apply window were empty. No restart
or configuration change occurred.

## Regression and cleanup

- Focused evidence plan/apply tests: 4/4 PASS.
- Full tests: 182/182 PASS.
- Typecheck, build, module boundaries, ranking/promotion, Phase 7G controls,
  vector repair, golden recall, and release gate: PASS.
- Golden recall: 1.0; forbidden violations: 0; prompt-budget exceeded: 0.
- Release package scan: 399 files.

One initial manual golden command used an obsolete filename and failed before
any state mutation. The actual repository entrypoint, `golden-benchmark.mjs`,
then passed. Generated dependency and package artifacts are removed during
exit cleanup; the encrypted snapshot, approval, and acceptance receipts are
retained as audit/rollback evidence.

## Exit boundary

The 90 rows now carry registry-resolved evidence but remain candidates with
their prior verification. This apply is not ownership confirmation, lifecycle
promotion, or recall cutover. The remaining 76 manual, 179 external-source,
and 287 quarantined rows were untouched. Any later use of the new evidence for
promotion requires a new read-only candidate plan and a separate exact
approval; ContextEngine, prompt mutation, and final recall remain disabled.
