# Phase 6 Experience Productization Audit - 2026-06-30

Scope: commercial memory plugin plan Phase 6.

## Model And Execution Gate

- Current session model was re-verified before this phase audit:
  `openai/gpt-5.5`.
- Current thinking mode was re-verified as `xhigh`.

## Changes Audited

Phase 6 turns Experience Kernel from a set of useful primitives into an
operator-checkable procedural-memory surface.

Files changed or verified:

- `benchmarks/experience-replay-cases.json`
  - Adds replay cases for config changes, Gateway recovery, vector repair,
    release gate, plugin rollout, and Telegram delivery.
- `cli.ts`
  - Adds `openclaw scope-recall experience replay --playbook-id <id>`.
  - Loads replay cases from JSON and returns stable JSON with pass/fail counts.
- `src/experience-replay.ts`
  - Validates required terms, negative terms, and step coverage against a
    playbook.
- `tests/experience-kernel.test.mjs`
  - Loads the repository replay fixture and verifies a complete runbook can
    pass all six common OpenClaw workflow cases.
- `src/experience-store.ts` and `src/experience-promotion.ts`
  - Existing gates keep failed, blocked, incomplete, low-signal, and unsafe
    traces from automatic promotion.

## Verification

Required verification for this phase:

```bash
node --test tests/experience-kernel.test.mjs tests/task-experience.test.mjs
npm run typecheck
npm run build
npm run release:gate
```

Release gate now checks the replay fixture IDs, CLI replay markers, and
workspace/live drift for `src/experience-replay.ts`,
`dist/src/experience-replay.js`, and the benchmark fixture.

## Audit Findings

- Preflight remains scope-filtered and bounded.
- Replay fixtures now exercise concrete OpenClaw workflows instead of abstract
  playbook existence.
- Bad or stale playbooks can be surfaced through review, quarantine,
  supersede, feedback counters, and replay failures.

## Remaining Risk

- The replay benchmark is deterministic term coverage, not a full task
  simulation. It is suitable as a release guard, but future commercial work can
  add end-to-end transcript replay and outcome scoring.
