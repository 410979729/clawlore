# Phase 7N post-assignment candidate-policy preview — 2026-07-12

## Plan position and boundary

This round remains in migration stage 4. It consumes the owner-only Phase 7L
exact evidence-assignment plan and Phase 7M acceptance receipt only to produce
a new query-only candidate-policy preview. It does not reuse the Phase 7M
approval and grants no evidence, lifecycle, verification, address, ContextEngine,
prompt, or final-recall authority.

Implementation commit `07ec5aa` adds a strict post-assignment planner, CLI, and
four regressions. The planner validates the exact assignment shape and every
rollout/plan/state/resolver/payload digest before interpreting an evidence row.
Direct-principal and conversation-boundary evidence are recognized as provenance
only; the planner does not synthesize a resolved principal or conversation id.

## Live read-only result

The first live run failed closed before creating a receipt because the Phase 7L
source summary recorded 952 V1 rows while current V1 had grown to 979. The 632
candidate hashes were unchanged. The control was narrowed to preserve exact V2
candidate/state/evidence matching while allowing only append-only V1 growth and
reporting that growth as a final-cutover blocker. A regression covers this case.

The final owner-only receipt is:

`workspace/archive/clawlore-phase7n-post-assignment-candidate-plan-20260712_231045/post-assignment-candidate-preview-20260712.json`

It has mode 0600 and SHA-256
`ad3bf7afc3c3a9e58620053eef45dd6f5104e4b1f92fd31b64453b7285dd1fbe`.

Live evidence validation:

- assigned evidence rows validated: 90/90;
- direct-principal: 76; conversation-boundary: 14;
- invalid or unplanned assigned evidence: 0;
- candidate set: exact 632-row baseline, missing planned candidates 0;
- candidate plan: 0 eligible, 476 hold, 156 quarantine;
- automatic promotion: 0; lifecycle rollout selectable: false;
- candidate plan digest:
  `b4f93105e76db3d639ef8d797dca327e6490375d6ba1018a88077ddbb600e74a`.

Registry resolution is not ownership confirmation. The assigned rows retain
unresolved addresses and prior verification, while automatic sources still lack
the required operator review/source receipts. No promotion approval is useful
for this plan because the eligible set is empty.

## Live parity and verification

Live exit state:

- V1/V2: 979/952;
- append-only V1 rows not mirrored to V2: 27;
- missing legacy backing rows for existing V2 items: 0;
- lifecycle: 0 active / 632 candidate / 320 archived;
- compatibility projection: 952; pending outbox: 0;
- SQLite integrity: `ok`; foreign-key violations: 0.

The 27 new V1 rows arrived after the approved additive migration while V2 writes
remained disabled. They do not alter this exact candidate-policy result, but
they block V1/V2 parity and final recall cutover. Handling them requires a new
read-only migration/projection plan and separate approval; this round does not
authorize such a write.

Verification passed:

- focused post-assignment tests: 4/4;
- full tests: 186/186;
- typecheck, build, module boundaries, ranking/promotion, Phase 7G controls,
  vector repair, golden recall, and release gate: PASS;
- golden recall 1.0, forbidden violations 0, prompt-budget exceeded 0;
- release package scan: 404 files.

Gateway stayed `active/running` with MainPID 4169210, `NRestarts=0`, healthz
live, port 19021 listening, and no warning-or-higher unit log entries in the
verification window. The receipt reports zero live evidence/lifecycle/
verification/address/runtime mutations; no configuration or service restart
was performed.

## Exit boundary

There is no candidate lifecycle rollout to approve: eligible rows remain 0.
The next plan-led task is to inspect and plan the 27 append-only V1 rows without
changing existing candidate lifecycle or enabling ContextEngine, prompt
mutation, or final recall.
