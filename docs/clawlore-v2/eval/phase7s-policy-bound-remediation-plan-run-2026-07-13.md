# Phase 7S policy-bound remediation and exact evidence plan — 2026-07-13

Phase 7S remains in migration stage 4 and is entirely query-only. Commit
`c699a2a` makes remediation preserve the Phase 7R policy dispositions instead
of reclassifying policy holds as quarantine. Commit `d87d5e6` keeps the new
assigned-evidence and legacy-provenance hold lanes as explicit holds when the
exact evidence plan is generated.

The 0600 remediation receipt is
`workspace/archive/clawlore-phase7s-evidence-remediation-20260713_011828/candidate-evidence-remediation-preview-20260713.json`
(SHA-256 `388fb60a3eb01cd5247a3107773b9c3d02a7cf155f3b80ea0641aa9fcb43f996`,
plan digest `efa947be5c31766e903e3d602a744f1652f0b5f53a17e55b123c779867ce432b`).
It preserves 504 hold / 156 quarantine exactly and splits the holds into 77
assignment review plus 427 evidence review. The only new assignment target is
one registry-direct row; 83 previously assigned rows remain evidence review,
76 manual rows remain unassigned, 206 derived-system rows await receipts, and
138 legacy-provenance holds remain non-actionable.

The 0600 exact plan is
`workspace/archive/clawlore-phase7s-evidence-remediation-20260713_011828/evidence-assignment-preview-r2-20260713.json`
(SHA-256 `117aa63536fa5d4732dea546d90f9a235fa4f419affc5137da3c1b2af3af86c2`,
plan digest `5bcbfbfabd64638188cdb68ed58de0d6fb0ee79ef14f2859c21bd12dbb027c05`).
It proposes evidence assignment for exactly one direct-principal row, keeps
503 holds and 156 quarantines unchanged, and authorizes neither evidence write
nor lifecycle/runtime mutation.

Focused remediation tests 4/4, affected evidence tests 8/8, full tests 196/196,
typecheck, build, module/ranking/control/vector/golden/release all pass; package
scan 417. Live remains V1/V2 980/980, lifecycle 0/660/320, all four projections
980, pending outbox 0, integrity ok, foreign keys 0. Gateway PID 4169210 is
unchanged, NRestarts 0, healthz live, warnings empty. The first full run exposed
four legacy fixture failures from an over-strict old-baseline digest check; the
check is now strict only for the new Phase 7R contract and the final full run
passes.

Any apply requires a fresh encrypted snapshot and a new exact approval bound to
the one-row plan digest. ContextEngine, prompt mutation, final recall, lifecycle,
verification, address, and the other 659 candidates remain outside scope.
