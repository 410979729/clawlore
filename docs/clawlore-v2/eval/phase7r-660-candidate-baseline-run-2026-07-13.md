# Phase 7R 660-candidate policy/evidence baseline — 2026-07-13

## Plan position and boundary

This round remains in migration stage 4. It creates a new query-only policy and
evidence baseline after the approved Phase 7Q append-only migration. It does
not authorize lifecycle mutation, ContextEngine, prompt mutation, or final
recall cutover.

Implementation commit `f9318a2` extends the existing post-assignment planner
without weakening its 632-row evidence-assignment controls. The old 632-row
set must still match the Phase 7L plan and Phase 7M acceptance exactly. The
additional 28 candidates are admitted only when an owner-only Phase 7Q
acceptance receipt is supplied and its live counts, projection counts,
classification split, verification, legacy-identity debt, review requirement,
and runtime denials all match.

## Live read-only result

The owner-only receipt is:

`workspace/archive/clawlore-phase7r-candidate-baseline-20260713_010425/candidate-policy-baseline-20260713.json`

It has mode 0600 and SHA-256
`9526592c145c6225ad35de0291e27cb84122b606bd5f85115b1984b987f9a4f2`.

Bound controls:

- Phase 7L assignment plan SHA-256:
  `9c324b328e72fc12a642e397c1f8ad1a9911e13efab441132efa09aaef6ad896`;
- Phase 7M assignment acceptance SHA-256:
  `b2e0822889cf76adc50df8d9d4149fe800f88ca89b6ce1a1967750e780469797`;
- Phase 7Q delta acceptance SHA-256:
  `606a6c4816c5a210d3bf6ae39d0aa21930557bf5eedc6aad66fca370645326e1`;
- candidate plan digest:
  `64f07394910eae30e8ea4e888ec17805400682931bc293c58ac7f8c39b18dc85`.

Live coverage and decision:

- existing assignment evidence validated: 90/90, consisting of 76
  direct-principal and 14 conversation-boundary rows;
- accepted delta validated: 28/28, consisting of 27 reflection summaries and
  1 operational checkpoint;
- candidate set: 660/660; 0 eligible, 504 hold, 156 quarantine;
- automatic promotion: 0; lifecycle rollout selectable: false;
- V1/V2: 980/980; unmirrored V1 rows: 0; missing legacy backing: 0;
- compatibility/current FTS/vector/relation projections: 980 each; pending
  outbox: 0.

The 28 new rows add 28 holds to the previous 476/156 disposition. They remain
unverified automatic-source candidates with unresolved legacy identity and no
operator review/source receipt. No lifecycle approval should be requested for
this baseline because its eligible set is empty.

## Regression and live verification

- focused baseline tests: 6/6 PASS;
- full plugin tests: 194/194 PASS;
- typecheck, build, module boundaries, ranking/promotion, Phase 7G controls,
  vector repair, golden recall, and release gate: PASS;
- golden recall 1.0, forbidden violations 0, prompt-budget exceeded 0;
- release package scan: 416 files;
- SQLite integrity `ok`, foreign-key violations 0;
- Gateway active/running, MainPID 4169210, `NRestarts=0`, healthz live, port
  19021 listening, and no warning-or-higher journal entries during the run.

The repository intentionally has no lockfile. `npm ci` therefore rejected the
first dependency restore; the existing no-lockfile install path was used, and
development dependencies were explicitly included before typecheck/build.
No lockfile is retained. The generated dependency tree was removed after
verification, the repository is clean, and `WORKSPACE_LAYOUT_OK` passes. State
hygiene still reports the same 68 pre-existing outside-workspace findings;
this round added none.

## Exit boundary

The baseline is evidence, not authority. It changes no database row,
configuration, service, lifecycle, verification, address, ContextEngine,
prompt, or final-recall state. The next useful work is another read-only
evidence-remediation plan over the 504 hold rows and 156 quarantine rows. Any
later write still requires a fresh encrypted snapshot and a new exact approval.
