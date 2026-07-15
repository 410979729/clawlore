# Phase 7T rollout approval gate removal — 2026-07-13

## Outcome

The repeated human approval-file gate has been removed from the ClawLore V2
source execution contract. Runtime shadow registration, fixture migration,
initial V2 rollout, compatibility backfill, append-only V1 delta apply,
evidence assignment, and candidate-promotion planning no longer parse or
require a separate approval JSON file.

The verified runtime entrypoint source, compiled entrypoint, and manifest were
then deployed to the live extension under the existing authenticated service-
change boundary. The Gateway restarted once to load them. The live database,
ContextEngine, prompt path, final recall, and memory truth were not mutated.

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

## Live deployment acceptance

- Service after restart: `ActiveState=active`, `SubState=running`,
  `MainPID=283612`, `NRestarts=1`, active since `2026-07-13 11:04:26 +08:00`.
- `/healthz`: `{"ok":true,"status":"live"}`.
- Loaded runtime entrypoints match commit `e065ed1` exactly:
  - `index.ts`: `6963ef6167fb969a153a484ce1c04c1e15f751a4cfb1221a7d6106fbe9f49f3f`;
  - `dist/index.js`: `a333895a2b83e60de28cb64e437c37926ef18f42512b7f3b92db4d1b6c1d5361`;
  - `openclaw.plugin.json`: `8cebae9296516840f459f9cce56e759428a9a0a78c6a876ca7ad6be843eecdc1`.
- Startup logs repeatedly report `status=registered`, `mode=shadow`, `hooks=1`,
  `writes=false`, `promptMutation=false`, `contextEngine=false`, and
  `blocks=none`.
- The live config still includes deprecated `approvalFile`, proving schema and
  parser compatibility. The Gateway read the 0600 readiness file at
  `2026-07-13 11:04:33 +08:00`, while the approval file atime remained
  `2026-07-12 03:37:02 +08:00`; live source references `approvalFile` only in
  the compatibility schema/parser and never passes it into rollout controls.
  Registration therefore neither read nor required the approval file.
- Joy's real Telegram direct message at `2026-07-13 11:06:05 +08:00` produced
  a 0600 redacted shadow receipt with resolved private identity,
  `same_private_principal`, retrieval invoked, two candidates, zero selected,
  zero used tokens, and `status=completed`. This was an observer-only smoke:
  no ClawLore memory write, prompt mutation, ContextEngine registration, or
  final-recall cutover occurred.
- Recent logs contain no ClawLore activation blocker or runtime error. Existing
  startup warnings concern the pre-existing insecure Control UI flag, Discord
  warmup timeout, and Telegram restart-delivery fallback, not this deployment.

The earlier failed turn was independently attributed to the upstream
`openai/gpt-5.6-sol` capacity response (`Selected model is at capacity`), not
to the Gateway or ClawLore deployment.

## Cleanup

No temporary scripts, databases, lock files, or test outputs were retained.
The pre-deployment copies of the three replaced live files remain as rollback
evidence under `archive/clawlore-phase7t-live-deploy-20260713_110138/`.
Historical approval receipts remain immutable audit evidence but are no longer
functional gates. The only remaining Phase 7S mutation is the one-row evidence
assignment, which still requires a fresh encrypted snapshot and reproduction
of exact plan digest
`5bcbfbfabd64638188cdb68ed58de0d6fb0ee79ef14f2859c21bd12dbb027c05`.

The nested project repository is clean after the documentation commit, and the
workspace-layout audit returns `WORKSPACE_LAYOUT_OK`. State hygiene
reports 70 outside-workspace findings in existing configuration backups,
session reset/deleted residue, and Codex temporary plugin documents. None are
inside this project or its deployment archive; they were not deleted under
this bounded rollout task.
