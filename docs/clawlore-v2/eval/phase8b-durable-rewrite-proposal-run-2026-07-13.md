# Phase 8B durable rewrite proposal — 2026-07-13

## Scope and outcome

Phase 8B converts the six Phase 8A durable-fact rewrite holds into three
bounded, capture-safe rewrite proposals. It does not write those proposals to
live memory. Each exact duplicate pair has one deterministic representative
selected by item-hash order; the companion remains candidate/unverified in a
post-rewrite dedupe hold. This prevents two identical rows from being rewritten
into two new identical rows.

The resulting partition is:

- 3 exact groups / 6 protected rows;
- 3 rewrite representatives;
- 3 post-rewrite dedupe holds;
- 2 groups already covered by current ClawLore truth;
- 1 materially new bounded truth group;
- 3 capture-safe proposals with 0 current-corpus collisions;
- 0 mutation-ready rows.

No content rewrite, soft archive, lifecycle, verification, ContextEngine,
prompt, or final-recall mutation occurred.

## Truth dedupe and implementation

The owner-only knowledge-dedupe receipt records the search terms, coverage
decision, and supporting file hashes without original memory content or raw
identifiers:

- `memory_capability_boundary` is already covered by the ClawLore RFC/README;
- `episode_before_reviewer` is already covered by the task-experience code and
  reviewer-skipped episode regression;
- `local_collaboration_control_plane` is materially new bounded truth. Generic
  MCP architecture documents do not state the complete authoritative-dispatch,
  authorization, acknowledgement, and acceptance boundary.

Commit `a5655c1` adds:

- a pure rewrite-proposal policy requiring complete group coverage, one unique
  fact key per group, safe knowledge evidence, and the deterministic first item
  hash as representative;
- capture-safety, length, no-op rewrite, current-corpus collision, and
  cross-proposal duplicate checks;
- an owner-only live planner that revalidates every Phase 8A protected row and
  permits only a fully converged append-only source extension outside targets;
- a redacted plan that carries content hashes and actions but no proposed or
  original memory text;
- an independent live acceptance script that recomputes plan/payload digests,
  verifies redaction, checks all six live bindings, and rejects source drift;
- regressions for incomplete/unsafe/colliding/non-deterministic specifications,
  append-only convergence, tampered payloads, and live-row drift.

The first collision regression incorrectly reused an unsafe command-trace
fixture, so the safety gate rejected it before the collision branch. The test
was corrected to use safe existing content; production policy was not relaxed.

## Owner-only controls and acceptance

Artifacts are retained mode 0600 under
`workspace/archive/clawlore-phase8b-durable-rewrite-proposal-20260713_1807/`.

- knowledge-dedupe receipt SHA-256:
  `160525b2f2eb05beee834509390d8e820913620d43f7f8c93395fbc10efdfe36`;
- rewrite payload digest:
  `b68632f4fb5eec7f1111421b95a64c525e07d3c2f95c106afc4a5f3db96a6c09`;
- rewrite payload file SHA-256:
  `8e001e549a93196dbcca30439ac9c61c33c5994c111f3c92176b69c40e0675f6`;
- redacted plan digest:
  `b2e1aec83c054039a942ec1db5769f0da3965bbf84ad5cee438655afcf085d78`;
- redacted plan file SHA-256:
  `b1c750d6423e7f06ed6f825b2855fe4f3d4c121517d7f48b574c2b793f8c86cc`;
- acceptance file SHA-256:
  `be2f416dc96934f32212e7d7fbc915d3486e0693ad6dd5ed224ab7423103f141`.

Independent acceptance found 0 live target mismatches, 0 proposed-content leak,
and 0 raw trace/identifier leak. All six rows remain candidate/unverified. The
plan explicitly sets content rewrite, soft archive, hard delete, lifecycle,
verification, ContextEngine, prompt mutation, and final recall authority to
false. A future apply requires a fresh encrypted snapshot and a separate exact
transaction.

## Verification and live boundary

- focused Phase 7Y/7Z/8A/8B tests: 16/16 PASS;
- full suite: 221/221 PASS;
- typecheck, build, module-boundary, runtime-composition, ranking, Phase 7G
  controls, vector repair, golden recall, and release gate: PASS;
- golden recall: 1.0; forbidden violations: 0;
- closing package scan: 459 files;
- live V1/V2 and compatibility/current FTS/vector/relation: 984/984;
- candidate 664 / active 0 / archived 320 / pending outbox 0;
- scope-recall doctor: `ok=true`, issues 0, SQL/FTS/vector 984/984/984;
- Gateway: `active/running`, MainPID 328735, NRestarts 1, healthz live, with no
  journal entries during the Phase 8B acceptance window.

## Next boundary

If Joy continues with live rewrite, the next exact phase must:

1. create and restore-verify a fresh encrypted snapshot;
2. replay the byte-identical three-representative plan and reject all drift;
3. write only three new current revisions while preserving candidate/unverified
   lifecycle, address, ACL, lineage, and runtime state;
4. leave all three companions candidate/unverified during that transaction;
5. rebuild content-quality/duplicate plans before deciding any companion soft
   archive.

The 14 Phase 8A reversible archive proposals and the other 131 unsafe rows stay
outside this phase.
