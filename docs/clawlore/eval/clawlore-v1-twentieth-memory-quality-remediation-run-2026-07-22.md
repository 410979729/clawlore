# ClawLore 1.2.2 twentieth memory-quality remediation run

Date: 2026-07-22

## Decision

The prior 1.2.1 candidate is not deployment-ready. Its build and supply-chain
evidence remain valid, but the independent production audit found a hidden
write in manual recall, inadequate no-answer evaluation, plaintext
secret-shaped material at rest, and a transcript pipeline that does not read
the active OpenClaw SQLite transcript store.

This run prepares a source-only 1.2.2 remediation candidate. It does not deploy,
change live configuration or cron, mutate production memory, rotate a
credential, or restart the Gateway.

## Implemented fixes

- `memory_recall` is read-only and no longer patches retrieved metadata.
- Manual recall has a separately owned confidence/abstention policy. Weak
  vector-only candidates require both a high semantic score and a clear top-1
  gap; ordinary lexical evidence uses an explicit threshold.
- The real-corpus evaluator requires positive and no-answer cases and reports
  Recall@3, Precision@3, MRR, abstention rate, and false positives. Live
  provider evaluation accepts only an owner-only key file and is distinguished
  from the deterministic compatibility run.
- The canonical secret policy now detects provider-bounded credentials whose
  opaque value appears before the API/key explanation.
- A read-only persisted-secret audit covers V1 truth, V2 items and revisions,
  Task Experience, digest records, and conversation memory. It emits counts,
  pattern names, and hashes only, and its implementation streams rows instead
  of loading the complete store into memory.
- Release guards reject a metadata-writing manual recall implementation or a
  benchmark that omits the negative/precision/abstention contract.

The manual confidence policy is a new domain module rather than more logic in
the retrieval hotspot. `src/retriever.ts` remains at its 1,425-line non-growth
ceiling, and the new module is independently classified and tested.

## Evidence and remaining blockers

The focused build, typecheck, and 25 recall/security tests passed. The first
complete suite exposed only candidate-maintenance failures: two old version
assertions, the new module's missing architecture classification, and hotspot
growth. Those were corrected without raising any line budget; the focused
governance rerun then passed 14/14.

The current operator corpus was upgraded from 40 positive questions to 40
positive plus 10 no-answer questions. The deterministic run abstained on all
10 no-answer cases but also rejected 9 positive cases: Recall@3 0.775,
Precision@3 0.7045, MRR 0.7375, abstention 1.0. This is a useful red gate, not a
value to tune away. It proves that deterministic vectors do not substitute for
the required live-provider semantic run.

The read-only production secret audit reports findings and a non-owner-only
conversation-memory database. Those remain live blockers until credentials are
rotated, an encrypted snapshot is taken, exact targets are purged across every
store, and the post-clean audit passes. The current controlled verifier is not
configured, so this source-only run cannot authorize those high-impact steps.

## Release boundary

1. Complete the full Linux source/pre-push gate on the exact clean commit.
2. Run the live-provider 40+10 corpus gate and require all quality thresholds.
3. Disable both bypass write crons and remove the stale app/source split.
4. Rotate potentially exposed credentials, snapshot, purge, and re-audit.
5. Set the deprecated `autoBackup` compatibility field false.
6. Only then perform migration, candidate deployment, live shadow observation,
   independent review, and a separately authorized cutover decision.
