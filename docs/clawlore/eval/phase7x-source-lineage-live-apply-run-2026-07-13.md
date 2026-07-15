# Phase 7X source-lineage live apply and remediation closure — 2026-07-13

## Scope and outcome

Phase 7X executed the regenerated Phase 7W source-lineage plan under a fresh,
restore-verified encrypted snapshot. It attached exactly 206 support-only
source-lineage receipts, preserved every canonical/lifecycle/verification/
address/runtime boundary, and then closed a post-apply planner defect that
could otherwise keep proposing receipts already present.

The live V1 writer appended one operational checkpoint during acceptance. A
second fresh snapshot and exact one-row r5 delta restored V1/V2 and all four
projections to 983/983. No lifecycle promotion, verification change,
ContextEngine enablement, prompt mutation, or final recall occurred.

## Exact 206-row evidence-only apply

The pre-apply replay was byte-identical to the Phase 7W plan: file SHA-256
`0cf2c258fe0b2542f35276df1d89277d5639b88936ed1668e10e14a63131940a`,
plan digest
`6754fa858dd6c9b3ffefe312651f15de3d92d368c6e7f92d97bac474e0424c15`,
206 targets, 0 incomplete rows, and 456 non-target candidates. Live truth was
982/982 with all projections at 982, candidate 662, active 0, archived 320,
pending outbox 0, existing lineage receipts 0, integrity `ok`, and foreign
keys 0.

The fresh r5 snapshot was created at 2026-07-13T07:40:50Z and restore-verified
all 982 V1 rows with logical digest `8a81f354...e2bfbee`. Encrypted archive
SHA-256 is
`8f51973defd572461557a68b86c2a72fe511dc4de7691133470144f8e68dc3ab`;
snapshot receipt SHA-256 is
`87eede73a70c1c1c34c56d1f695f041375d080ac7025553f4318c301a9d12ccf`.
The post-snapshot replay remained byte-identical.

The transaction wrote only `sourceLineageReceiptV1` for the 206 exact current
sources. Apply receipt SHA-256 is
`1861b79c8602f37af239aea952bbfd8b008b65054c306533b0ae6a222bd0e425`.
Independent SQL acceptance proved:

- 206 receipts on 206 distinct current candidate items;
- 206 reflection-summary and source-only receipts;
- all 206 explicitly deny lifecycle and verification authority and preserve
  candidate/unverified state;
- non-target evidence, migration events, canonical items, lifecycle,
  verification, address, projections, pending outbox, and runtime controls
  changed by 0;
- registry assignment evidence remained 91.

## Post-apply planner closure

The first post-apply remediation preview exposed a real state-transition gap:
valid source-lineage receipts were not recognized as completion of the receipt
attachment step, so a stale remediation could continue to propose the same
rows. Commit `68dc34f` adds structural receipt validation and moves valid rows
to `source_lineage_content_review`. Invalid receipts remain fail-closed in the
derived-system evidence lane with an explicit repair action. The lineage
planner now also rejects any stale remediation target that already contains a
receipt and requires a fresh preview.

The regenerated post-apply lineage plan has 0 targets, 0 incomplete rows, and
663 non-targets; digest
`96ee277b822f587d0603ea770c10ae5ffbdf697c6126ee3b4621f27b75ccda4e`.
The new remediation counts are 79 assignment review / 428 evidence review /
156 quarantine, where 206 of the evidence rows are now explicitly in
source-lineage content review. Mutation-ready rows remain 0.

## Continuous V1 drift and cumulative delta control

Acceptance detected a new V1 append before treating the post-apply baseline as
valid: V1/V2 was 983/982. The separate read-only r5 plan covers exactly one
operational checkpoint, digest
`ceb6cec4533d4fc6f7b9ed8035c3211c80c7517460b70646acfb583f16f50136`,
and authorizes no delta write by itself.

The second fresh r6 snapshot restore-verified 983 V1 rows with logical digest
`9a9ef876...5df7ee`; encrypted archive SHA-256 is
`b516117f879946efd30dafeca17380df3a2c37928c581a98b5f5d2f9742f3912`
and receipt SHA-256 is
`d7065bd5ed44b5972c34a525e7d190120d5cd290802ee91263d19e7d412c44e2`.
The exact r5 transaction then appended one candidate/unverified operational
checkpoint, moved V2 and all four projections 982 -> 983, added three processed
outbox rows, and left pending outbox 0. Apply receipt SHA-256 is
`d1c0f80ab16ac6c084b5628bef04b0503370361dd904d85ccbba561ce683b6c5`.

Because the current 663-candidate baseline contains both the Phase 7W r4 and
Phase 7X r5 append generations, it is bound to a cumulative, non-overlapping
two-control acceptance. The cumulative plan digest is
`62cb74e552bfae9ba6af6cff16f95b49635618cbd55224ebd73df33e995a99b7`.
The resulting query-only policy baseline is 0 eligible / 507 hold / 156
quarantine; candidate count 663, active 0, archived 320, and automatic
promotion 0.

## Verification and retained evidence

- focused remediation/lineage tests: 9/9 PASS;
- full suite: 205/205 PASS;
- typecheck, build, module boundaries 2/2, runtime composition,
  ranking/promotion, Phase 7G controls, vector repair, golden recall, and release
  gate: PASS;
- closing package scan: 431 files;
- scope-recall doctor: `ok=true`, issues 0, SQL/FTS/vector 983/983/983,
  SQL/vector scopes equal;
- Gateway: active/running, MainPID 328735, NRestarts 1, healthz live, warning
  journal empty during the apply window.

Owner-only encrypted snapshots, exact plans, apply receipts, acceptance
controls, and regenerated query-only outputs are retained mode 0600 under
`workspace/archive/clawlore-phase7x-source-lineage-apply-20260713_153840/`.
Plaintext restore databases and WAL/SHM files were removed.

The next safe stage is operator content-quality review of the 206 receipts plus
the remaining assignment/evidence lanes. Source lineage proves provenance
continuity only; it does not authorize lifecycle, verification, ContextEngine,
prompt mutation, or final recall.
