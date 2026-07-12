# Phase 7K candidate evidence remediation workbench — 2026-07-12

## Plan position and boundary

This round resumed from the migration plan plus the TODO/project/day handoff.
Phase 7J closed the FTS compatibility blocker but did not close migration stage
7: V2 still has zero active rows, so no production-recall cutover is permitted.

The Phase 7K workbench is query-only. It reads legacy metadata, V2 lifecycle and
source classifications, and the owner-only sessions registry. It does not read
memory text or transcript content and emits no raw item, principal,
conversation, session, or metadata values. It cannot write evidence, change
lifecycle, enable ContextEngine, mutate prompts, or switch final recall.

## Implementation

Commit `cbce404` adds:

- `src/v2/operator/live-candidate-evidence-remediation.ts`;
- a private-control, read-only CLI under `scripts/`;
- focused redaction and stale-baseline tests;
- a package command for the live query-only preview.

The workbench binds itself to the Phase 7H/7J candidate promotion digest and
the exact 632 hashed candidate ids. It fails closed if the baseline preview or
registry is not owner-only, if the candidate set has changed, or if live counts
change while planning.

## Live read-only result

The owner-only receipt is:

`workspace/archive/clawlore-phase7k-evidence-remediation-20260712_215628/candidate-evidence-remediation-preview-20260712.json`

It is mode 0600 and records:

- V1/V2 952/952; lifecycle 0 active / 632 candidate / 320 archived.
- Compatibility projection 952; pending outbox 0.
- Assignment review 166: 76 registry-direct, 14 registry-conversation, and 76
  manual principal-assignment rows.
- Evidence review 179: derived/system rows that still need source receipts and
  explicit operator review.
- Quarantine 287: 66 legacy agent aliases, 77 opaque references, and 144
  unknown-legacy rows.
- Mutation-ready rows 0; automatic promotion 0; lifecycle authority false.
- Plan digest
  `a0c8ee2d92a67cc9d1edd9e03d4b9ce8f9d5b42854b4173ed7fad21d0b3a2495`.

Registry evidence narrows the review queue but does not itself confirm that a
memory belongs to a principal or conversation. Any evidence write or lifecycle
change requires a separate exact-plan operator decision and rollback controls.

## Verification

- Focused tests: 2/2 PASS.
- Full tests: 178/178 PASS.
- Typecheck and build: PASS.
- Module boundaries, ranking policy, Phase 7G controls, vector repair, and
  golden recall: PASS.
- Golden recall 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Release gate: PASS; package scan 389 files.
- Gateway active/running, healthz live, `NRestarts=0`, MainPID unchanged from
  the start of the round, and no warning-or-higher unit log since the round
  began.

## Next gate

Do not bulk-assign the 166 review rows and do not promote any candidate. The
next live mutation, if selected, must bind a fresh snapshot, an exact evidence
assignment plan, explicit operator decisions, rollback instructions, and a
post-apply re-preview. ContextEngine, prompt mutation, and final recall remain
outside that approval.
