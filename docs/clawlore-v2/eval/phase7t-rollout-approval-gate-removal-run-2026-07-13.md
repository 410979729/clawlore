# Phase 7T rollout approval gate removal — 2026-07-13

## Outcome

The repeated human approval-file gate has been removed from the ClawLore V2
source execution contract. Runtime shadow registration, fixture migration,
initial V2 rollout, compatibility backfill, append-only V1 delta apply,
evidence assignment, and candidate-promotion planning no longer parse or
require a separate approval JSON file.

This round changes the source repository only. The currently loaded live
extension, `openclaw.json`, database, ContextEngine, prompt path, final recall,
and Gateway process were not mutated or restarted.

## Retained machine boundaries

Removing the human gate did not remove the controls that detect an unsafe or
stale operation:

- owner-only readiness, plan, snapshot, and receipt files;
- exact rollout ids and plan digests;
- live source, resolver, candidate-set, and projection drift rejection;
- fresh AES-256-GCM snapshot and restore verification before bounded writes;
- `BEGIN IMMEDIATE` transactional scope checks and post-write integrity checks;
- V1 fallback, lifecycle/verification preservation where required, projection
  convergence, rollback evidence, and explicit ContextEngine/prompt/final-
  recall denials.

The irreversible hard-delete confirmation remains. It is a different boundary
from staged rollout approvals and still prevents accidental destructive purge.

## Compatibility

`clawloreV2.approvalFile` remains accepted by the manifest and config parser as
a deprecated ignored field. It is never loaded or passed to runtime controls.
This keeps the existing live configuration valid until a later authenticated
deployment removes the stale key.

The rollout ledger now uses `control_sha256` instead of
`approval_sha256`. Append-delta apply transactionally renames the legacy column
when it first encounters an existing live schema. The regression fixture starts
with the legacy column and proves the migration leaves only
`control_sha256`.

## Verification

- focused approval-removal bundle: 20/20 PASS;
- full tests: 196/196 PASS;
- typecheck: PASS;
- build: PASS;
- module boundaries: 2/2 PASS;
- runtime composition smoke: PASS, one shadow observer, writes/prompt/
  ContextEngine all false;
- ranking/promotion smoke: PASS with `eligible_for_promotion` and no approval
  contract;
- Phase 7G controls smoke: `status=ready`, blockers 0;
- vector repair smoke: PASS;
- golden recall: recall 1.0, Top-K accuracy 1.0, forbidden violations 0,
  prompt-budget exceeded 0;
- release gate: PASS; package scan 418 files.

The first Phase 7G smoke run exposed a pre-existing fake-green condition: the
script exited zero while reporting `status=blocked` because its compatibility
fixture omitted `bootstrapSource`. The fixture was corrected and the smoke now
throws unless status is `ready` with zero blockers.

## Live exit evidence

Read-only exit checks showed Gateway `active/running`, `MainPID=4169210`,
`NRestarts=0`, and `/healthz` returned `{"ok":true,"status":"live"}`. The live
extension and configuration still contain the old functional approval gate;
their source hashes differ from this verified repository. Live deployment and
the one-row Phase 7S evidence apply remain pending.

## Cleanup

No temporary scripts, snapshots, databases, archives, lock files, or test
outputs were retained. Existing `node_modules` remains because it predated this
round and is still needed for the pending deployment verification. Historical
approval receipts and dated Phase 7 reports remain immutable audit evidence.
