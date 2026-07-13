# Phase 7S policy-bound remediation and exact evidence plan — 2026-07-13

The initial Phase 7S planning portion remained in migration stage 4 and was
entirely query-only. Commit
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

## Live closure after Phase 7T

The first pre-apply replay failed closed before snapshot or mutation because
legacy V1 had appended one operational checkpoint: V1/V2 was 981/980 while the
original 660-candidate set and all four projections remained unchanged. Commit
`86dd665` lets the append-delta planner consume the later policy-baseline zero-
eligible field without weakening its mandatory zero check. Focused 7/7,
typecheck, build, and then full 197/197 passed before the live delta.

A read-only r3 delta plan covered exactly one operational checkpoint as
candidate/unverified/legacy-identity debt, with plan digest
`680a69ca000e2762470a858171f3824cba1c862ad2b28685e30ec3e161fec178`.
A fresh AES-256-GCM snapshot restored 981 rows with matching logical digest,
integrity `ok`, foreign keys 0, and no plaintext/WAL/SHM residue. The bounded
transaction added one V2 row, one row to each compatibility/current FTS/vector/
relation projection, and three processed outbox rows. Existing canonical,
lifecycle, verification, and evidence changes were all 0. V1/V2 and all four
projections converged at 981; pending outbox stayed 0.

The rebuilt 661-candidate baseline remained 0 eligible / 505 hold / 156
quarantine. The newly migrated checkpoint also became registry-resolvable,
which would have expanded the assignment set from one to two. Commit `e6bfc71`
adds a strict hashed target allowlist to the exact plan and binds it into the
plan digest. Full regression then passed at 198/198. The allowlist retained only
the original Phase 7S target; its item, current-state, and resolver-evidence
digests matched the old plan exactly. The rebuilt exact plan covered 1 write,
504 explicit holds, and 156 quarantines with digest
`a642d63d04c4c281fa22a604cb4092bcd838747af89b70d7785cd2d98e2d3cd4`.

A second fresh encrypted snapshot passed the same restore/integrity/FK/plaintext
checks. The final transaction wrote exactly one direct-principal evidence row.
Manual, external-source, quarantine, and non-target evidence changes were 0;
canonical item, lifecycle, verification, address, compatibility, and pending-
outbox changes were 0. Independent readback found 91 total registry-evidence
rows, exactly one from r3; the target remains candidate/unverified. The closing
remediation state is 77 assignment review / 428 evidence review / 156
quarantine, so the requested original one-row apply is complete while the new
checkpoint remains held.

Neither transaction read or required a human approval file. Authorization came
from Joy's direct continue instruction plus the machine-enforced exact plans,
fresh snapshots, drift checks, transaction boundaries, and post-write receipts.

Final gates: full 198/198, typecheck/build, module 2/2, runtime composition,
ranking, Phase 7G controls, vector repair, golden recall, and release gate all
PASS; package scan 419 files. ContextEngine, prompt mutation, final recall, and
lifecycle promotion remain disabled. Owner-only rollback/control evidence is
retained under
`workspace/archive/clawlore-phase7s-one-row-apply-20260713_1117/`.
All retained files are owner-only; no plaintext restore database, WAL/SHM,
temporary log, or lock file remains. The nested repository is clean and
`WORKSPACE_LAYOUT_OK` passes. State hygiene remains at the same 70
outside-workspace configuration/session/Codex-cache findings; this closure
added no new category and did not delete unrelated residue.
