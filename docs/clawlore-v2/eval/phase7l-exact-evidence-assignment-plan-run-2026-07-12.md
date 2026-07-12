# Phase 7L exact evidence-assignment plan — 2026-07-12

## Plan position and boundary

This round follows migration stage 4, not cutover stage 7. It resumes from the
Phase 7K remediation workbench and converts the exact 632-row queue into a
write-shaped but still read-only plan. The planner cannot write evidence,
change lifecycle or verification, enable ContextEngine, mutate prompts, or
switch final recall.

The plan is bound to the owner-only Phase 7K receipt, its exact Phase 7H/7J
promotion baseline, the current sessions registry checksum, and a per-row
digest of item id, current revision, address, lifecycle, and verification. It
reads no memory text or transcript content and emits no raw identifiers.

## Implementation

Commit `6d0a14d` adds:

- `src/v2/operator/live-evidence-assignment-plan.ts`;
- an owner-only read-only CLI under `scripts/`;
- exact-coverage, redaction, and registry-drift tests;
- package command `preview:clawlore-evidence-assignment`.

The planner fails closed on control-file permission/contract failure,
promotion-baseline checksum drift, remediation plan/row drift, sessions
registry evidence drift, incomplete candidate coverage, missing exact resolver
evidence, or a live remediation change while planning.

## Live read-only result

Proposed rollout id:

`clawlore-v2-evidence-assignment-20260712-r1`

Plan digest:

`0f432fad09130287181fc811e8a61cc80f42ed6d10ace7d2d3c0077b9aec4e1c`

Owner-only receipt:

`workspace/archive/clawlore-phase7l-evidence-assignment-20260712_221451/evidence-assignment-preview-20260712.json`

The 632 candidates are covered exactly once:

- 76 direct-principal rows propose registry-resolved identity evidence.
- 14 conversation rows propose registry-resolved boundary evidence.
- 76 manual rows stay candidate and unassigned, preserving Joy's earlier
  decision not to infer ownership.
- 179 derived/system rows wait for external source receipts.
- 287 rows retain quarantine.

All 632 rows preserve lifecycle `candidate` and their current verification.
Automatic promotion, lifecycle changes, and verification changes are 0. The
receipt is mode 0600 and explicitly sets evidence-write, lifecycle,
ContextEngine, prompt-mutation, and final-recall authority to false.

## Verification

- Focused Phase 7K/7L tests: 4/4 PASS.
- Full tests: 180/180 PASS.
- Typecheck and build: PASS.
- Module boundaries, ranking/promotion, Phase 7G controls, vector repair, and
  golden recall: PASS.
- Golden recall 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Release gate: PASS; package scan 394 files.
- Live V1/V2 952/952; lifecycle 0 active / 632 candidate / 320 archived;
  compatibility projection 952; pending outbox 0; integrity `ok`; foreign-key
  violations 0.
- The live SQLite mtime remained 2026-07-12 21:15:29 +0800 and `openclaw.json`
  remained at 2026-07-12 12:03:22 +0800, proving this round did not write them.
- Gateway active/running, healthz live, port 19021 listening, MainPID 4169210,
  `NRestarts=0`, process start 15:26:15, and no warning-or-higher unit log since
  22:05.

## Exit and next gate

No snapshot, evidence row, lifecycle, verification, configuration, runtime, or
service mutation occurred. Applying the 90 proposed evidence assignments must
first create and verify a fresh encrypted snapshot and then consume a separate
approval bound to the exact rollout id and plan digest. The other 542 rows must
remain untouched. V1 fallback, ContextEngine, prompt mutation, and final recall
remain outside that approval.

Generated dependencies were removed. The candidate repository is clean,
`WORKSPACE_LAYOUT_OK` passes, and the archive retains only the 0600 plan
receipt. State hygiene still reports the same 68 unrelated historical findings
outside the project; this round added none.
