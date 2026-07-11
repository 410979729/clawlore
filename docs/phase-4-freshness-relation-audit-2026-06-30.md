# Phase 4 Freshness And Relation Audit - 2026-06-30

Scope: commercial memory plugin plan Phase 4 baseline.

## Model And Execution Gate

- Current session model was re-verified before this phase audit:
  `openai/gpt-5.5`.
- Current thinking mode was re-verified as `xhigh`.

## Changes Audited

Phase 4 added partial freshness visibility and conservative relation-aware
recall scoring.

Files changed:

- `src/smart-metadata.ts`
  - Added normalized freshness fields:
    `observed_at`, `valid_until`, `freshness_status`,
    `live_check_needed`, and `source_confidence`.
- `src/operator-dashboard.ts`
  - Adds a `freshness` section.
  - Adds `summary.freshness_status` and `summary.freshness_debt`.
  - Counts each debt row once even when a stale row also needs a live check.
- `src/retriever.ts`
  - Adds a `relation_evidence` trace stage to vector, BM25, and hybrid paths.
  - Applies conservative in-candidate scoring:
    conflict-review and stale/live-check evidence are penalized; support and
    contextual relation evidence can receive a small boost.
  - Does not expand the candidate pool through relations, so scope filters still
    govern the full retrieval set.
- `tests/governance-alignment.test.mjs`
  - Covers dashboard freshness debt.
- `tests/retrieval-relation.test.mjs`
  - Covers relation evidence penalizing conflict-review rows without expanding
    scope.

## Verification

Commands already run in this phase:

```bash
node --test tests/governance-alignment.test.mjs tests/conflict-governance.test.mjs tests/retrieval-relation.test.mjs
npm run typecheck
npm run build
```

Results:

- Targeted Phase 4 tests passed: 11 passed, 0 failed.
- TypeScript typecheck passed.
- Build passed.

## Audit Findings

- Freshness debt is now visible in the operator dashboard.
- Relation evidence can improve or penalize recall ordering without bypassing
  scope filters.
- Contradictions remain reviewable metadata, not silent overwrites.
- Graph hygiene already covers orphan and hidden-lifecycle relation companion
  rows; this phase keeps that behavior and adds recall-side use of relation
  evidence.

## Remaining Risk

- This is partial Phase 4 maturity. Dedicated relation extraction for owned-by,
  affects, depends-on, and same-topic relation types is still not implemented.
- Doctor does not yet expose freshness debt; dashboard does.
- Relation-aware explain output is still limited to retrieval trace/source
  metadata and needs a richer operator-facing explanation later.
