# Phase 7W V1 delta convergence and assignment-control chain — 2026-07-13

## Scope and outcome

Phase 7W completed the exact one-row r4 delta selected by Joy after Phase 7V,
restored live V1/V2 parity, repaired a real multi-generation assignment-control
gap in the query-only candidate planner, and regenerated the candidate,
remediation, and source-lineage plans. The 206 source-lineage receipts were not
written.

## Fresh snapshot and exact delta

The owner-only fresh snapshot was created at 2026-07-13T07:10:37Z using the
existing file SecretRef key. It encrypted and restore-verified 982 V1 rows with
logical digest `8a81f354...e2bfbee`, integrity `ok`, foreign keys 0, and removed
the plaintext restore family. Archive SHA-256 is
`81aab191c8a3272ce14a48654193fd1ed0e8679a78284573aed596a7492bddee`;
snapshot receipt SHA-256 is
`c471ceb4d50157587285f4386b63b6b85cad12790cd97a13fac7557bbac5c58e`.

The transaction replayed the exact r4 plan SHA-256
`da9a304639281a364c694946c9342590b123dc939f3ed9ab894fb713353da087`
and digest `cef0b285...2c6c3a`. It appended exactly one operational checkpoint
as candidate/unverified/legacy-identity debt. V2 moved 981 -> 982, candidate
661 -> 662, all four projections moved 981 -> 982, three processed outbox rows
were added, and pending outbox stayed 0. Existing canonical, lifecycle,
verification, and evidence changes were all 0. V1 remained unchanged at 982;
ContextEngine, prompt mutation, final recall, and existing-candidate lifecycle
mutation remained disabled. Apply receipt SHA-256 is
`3863a4936eb1cf283c8653e027bb79e2a23f6035e069f5bbca87f7c98e37aeec`.

## Assignment-control chain root cause and repair

The first post-write baseline attempt failed closed. An early retry used the
old Phase 7M assignment control alone and correctly rejected the later Phase 7S
evidence. A retry with only the Phase 7S control also correctly rejected the 90
earlier evidence rows. The underlying planner could validate one assignment
generation but live truth now contains two independently accepted generations.

Commit `2499f50` adds a non-overlapping assignment-control chain. Every assigned
source must match the exact target row, state digest, resolver digest, payload
digest, rollout id, plan digest, and acceptance counts from one chain member.
Targets outside the current candidate baseline, overlapping targets, missing
controls, or unplanned evidence fail closed. The CLI accepts paired repeated
prior plan/acceptance arguments. Two regressions prove a complete chain passes
and an incomplete chain fails.

The live read-only baseline validates 91 evidence rows: 77 direct-principal and
14 conversation-boundary rows across the 90-row Phase 7M control and one-row
Phase 7S control. The new r4 delta remains separate and validates exactly one
operational checkpoint. Candidate result: 0 eligible / 506 hold / 156
quarantine, automatic promotion 0.

## Regenerated query-only plans

Owner-only evidence is retained under
`workspace/archive/clawlore-phase7w-v1-delta-and-regeneration-20260713_1504/`:

- candidate baseline SHA-256 `5b8c7eb5...c95d99`, plan digest
  `1c42a076...96074f`;
- remediation SHA-256 `db182c4f...d16538`, plan digest
  `c7cbaa5d...e78023`, with 78 assignment review / 428 evidence review / 156
  quarantine and mutation-ready rows 0;
- source-lineage plan SHA-256 `0cf2c258...31940a`, plan digest
  `6754fa858dd6c9b3ffefe312651f15de3d92d368c6e7f92d97bac474e0424c15`.

The lineage plan still covers exactly 206 reflection summaries, has 0
incomplete rows and 456 non-targets, and authorizes no evidence, lifecycle,
verification, ContextEngine, prompt, or final-recall mutation.

## Verification and boundary

- focused assignment/delta tests: 15/15 PASS;
- full suite: 204/204 PASS;
- typecheck, build, module boundaries 2/2, runtime composition,
  ranking/promotion, Phase 7G controls, vector repair, golden recall, and release
  gate: PASS;
- closing package scan: 430 files;
- scope-recall doctor: `ok=true`, issues 0, SQL/FTS/vector 982/982/982,
  SQL/vector scopes equal;
- Gateway: active/running, MainPID 328735, NRestarts 1, healthz live, warning
  journal empty during the apply window.

The next source-lineage apply, if selected, must use the regenerated digest and
a new fresh encrypted snapshot. It remains evidence-only and cannot substitute
for content review or authorize lifecycle/runtime cutover.
