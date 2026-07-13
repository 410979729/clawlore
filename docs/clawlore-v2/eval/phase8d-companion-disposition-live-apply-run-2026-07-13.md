# Phase 8D companion disposition live apply — 2026-07-13

## Scope and outcome

Phase 8D handles only the three post-rewrite companion rows retained by Phase
8C. Each row is still an unsafe operational trace, while its paired Phase 8C
representative now carries the bounded durable fact in capture-safe prose. The
separate 14-row reversible archive proposal, all remaining command/tool/
oversized lanes, the two safe duplicates, and the 56 semantic-review rows are
outside this transaction.

The live transaction soft-archived exactly those three companions. It created
one archived revision, source, supersedes relation, and archived event per
target. Current content, verification, address, ACL, V1 truth, all four
projections, pending outbox, non-target rows, and runtime cutover controls were
preserved. No hard delete occurred.

## Exact control and snapshot boundary

Owner-only evidence is retained under
`workspace/archive/clawlore-phase8d-companion-disposition-20260713_2054/`.

- disposition plan digest:
  `fe2614ec8698537b465b39df1a4f9f69e566f3aff27e334290f650d45fcbacc2`;
- plan SHA-256:
  `09ee920b4eaf318825ebc220c5148cbf499ff111b639dc4a24ccbcefb4c8d716`;
- independent disposition acceptance SHA-256:
  `b263c1f0dfe1274f781798e4eeb6f741f28d0c7cd62680e4035a89fdfa1f31fa`;
- encrypted archive SHA-256:
  `880268299781334f4be9b1458e67752402c0e74cd5d8055a3ced3554ae6711ec`;
- snapshot V1 logical digest:
  `c792ea649f6ec32e04227579b7888c4c67c192227b11565b5fc008924aec3c82`;
- apply receipt SHA-256:
  `ff92668845d53444237f19a58d0782d717b6c3ced8cd62ea824d7d85280a5ea9`;
- postcheck SHA-256:
  `c5a34c6bd8a31856a08c25e31ebc4d17077ecd5b97d43ce1410504db58fd4e24`.

The snapshot is restore-verified, ciphertext-only, and mode 0600. The exact
planner binds each companion to its current item/revision/content/normalized-
content/source-lineage digests and to the matching representative rewrite
receipt. Two groups are already covered by current ClawLore truth; the third is
represented by the new bounded Phase 8C rewrite. The plan and acceptance emit
hashes and decision metadata only.

## Live transaction and independent postcheck

The exact apply changed lifecycle only for the three targets:

- candidate: 665 -> 662;
- archived: 320 -> 323;
- active: 0 -> 0;
- new archived revisions/sources/supersedes relations/events: 3 each;
- prior companion revisions marked superseded: 3;
- current content, verification, address, ACL, and non-target changes: 0;
- compatibility/current FTS/vector/relation-projection changes: 0;
- pending outbox changes: 0.

V1/V2, compatibility FTS, current FTS, vector, and relation projections remain
985/985. Archived rows retain projection records for compatibility and audit;
normal recall still suppresses them through lifecycle filtering. Projection
retention is not final-recall enablement.

The independent query-only postcheck found exactly 3 archived companions, 3
preserved candidate representatives, 3 valid disposition receipts, 3
supersedes relations, 3 archived events, 3 complete four-projection bindings,
and 0 mismatches. Database integrity is `ok` and foreign-key violations are 0.

## Post-archive candidate and quality rebase

Commit `f8ea2f4` adds the exact disposition and soft-archive path. Commit
`5362a59` adds the independent postcheck and a fail-closed candidate rebase
that binds the prior 665-row baseline to the exact archive apply and postcheck
before removing only the three target hashes. The rebuilt policy baseline is:

- 662 candidates;
- 0 eligible / 506 hold / 156 quarantine;
- assignment review 81 / evidence review 425 / quarantine 156;
- source-lineage content review 203;
- content quality: 145 unsafe, 2 safe duplicate, 56 semantic review;
- capture safety: 14 duplicate traces, 7 unique oversized traces, 109 command
  traces, and 15 tool payloads;
- mutation-ready 0.

All rebuilt plans are query-only and authorize no additional archive, rewrite,
verification, lifecycle, ContextEngine, prompt mutation, or final recall.

## Verification and diagnostics

- focused companion tests: 5/5 PASS;
- full suite: 229/229 PASS;
- typecheck, build, vector repair, golden recall, and release gate: PASS;
- release pack scan: 478 files;
- golden recall: 1.0; forbidden violations: 0;
- scope-recall doctor: `ok=true`, issues 0, SQL/FTS/vector 985/985/985;
- Gateway: `active/running`, MainPID 328735, NRestarts 1, healthz live;
- no ClawLore warning/error entry was present in the Phase 8D journal window.

The first live preview intentionally failed closed on a semantically identical
projection-count field that used two historical names. The comparison was
normalized field-by-field before any plan receipt or database write. A later
postcheck invocation used a nonexistent workspace database path and failed at
read-only open; rerunning against the configured live SQL truth completed the
postcheck without replaying the transaction.

## Cleanup and remaining roadmap

Development dependencies, the one npm diagnostic log, probe directories, and
all plaintext database/WAL/SHM/temp artifacts were removed. The encrypted
snapshot and the minimal owner-only controls remain for rollback and audit.

Four planned decision phases remain, subject to fresh live evidence: Phase 8E
for the separate 14-row reversible archive lane; Phase 8F for remaining unsafe
command/tool/oversized lanes; Phase 8G for the two safe duplicates and 56
semantic-review rows; and Phase 9 for an explicit lifecycle/final-recall
cutover-or-no-cutover decision. None is authorized by Phase 8D.
