# Phase 3 Commercial Retrieval Audit - 2026-06-30

Scope: commercial memory plugin plan Phase 3 baseline.

## Model And Execution Gate

- Current session model was re-verified before this phase audit:
  `openai/gpt-5.5`.
- Current thinking mode was re-verified as `xhigh`.

## Changes Audited

Phase 3 upgraded the golden recall benchmark from a returned-id smoke into a
commercial metric gate.

Files changed:

- `benchmarks/golden-recall-cases.json`
  - Added scope-isolation fixture rows for `project:alpha` and `project:beta`.
  - Added invalidated stale/current fact rows.
  - Added per-case prompt budgets and result limits.
- `scripts/golden-benchmark.mjs`
  - Emits aggregate `summary` metrics:
    `knownAnswerRecall`, `topKAccuracy`, `forbiddenViolationRate`, latency
    percentiles, prompt-budget hit rate, and filter counts.
  - Emits per-case expected/forbidden ids, missing ids, violations, latency,
    prompt-budget data, and stage traces.
  - Fails on missing expected ids, forbidden ids, rank misses, and prompt-budget
    overruns.
  - Applies scope filtering and inactive/invalidated-row filtering in the
    benchmark pipeline.
- `docs/response-contracts.md`
  - Makes benchmark summary metrics required instead of future targets.
- `docs/openclaw-contract-matrix.md`
  - Marks retrieval benchmark and Recall Funnel trace work as `partial`.
- `scripts/release-gate.mjs`
  - Gates benchmark metric markers and fixture coverage.

## Verification

Commands already run in this phase:

```bash
node scripts/golden-benchmark.mjs
npm run typecheck
npm run build
```

Golden benchmark result:

- `totalCases`: 4
- `expectedHits`: 4 / 4
- `knownAnswerRecall`: 1
- `topKAccuracy`: 1
- `forbiddenViolations`: 0
- `promptBudget.hitRate`: 1
- `filterCounts.scopeFiltered`: 2
- `filterCounts.inactiveFiltered`: 1

Typecheck and build passed.

## Audit Findings

- The benchmark now catches known-answer regression, forbidden-id leakage,
  project scope leakage, invalidated stale fact leakage, and prompt budget
  regressions.
- Per-case stage traces expose at least FTS candidates, scope filtering,
  active filtering, and final-limit filtering.
- This is not yet a full runtime Recall Funnel implementation: live retriever
  trace and `memory_explain_rank` still need source-pool, rerank-input,
  final-prompt-budget, and rank-aligned evidence parity.

## Remaining Risk

- Runtime recall surfaces are still `partial`; the commercial benchmark is now
  strong enough to block fixture regressions but not every real-world bad
  recall.
- Relation-aware and freshness-aware ranking remain Phase 4 work.
