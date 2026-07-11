# Phase 5 Digest Audit - 2026-06-30

Scope: commercial memory plugin plan Phase 5.

## Model And Execution Gate

- Current session model was re-verified before this phase audit:
  `openai/gpt-5.5`.
- Current thinking mode was re-verified as `xhigh`.

## Changes Audited

Phase 5 productizes an OpenClaw-native digest baseline without making
background capture aggressive by default.

Files changed or verified:

- `src/digest-pipeline.ts`
  - Defines `openclaw_digest_runs` and `openclaw_digest_chunks` ledgers.
  - Tracks run statuses: `ok`, `ok_with_fallback`, `empty`, `filtered`,
    `parse_error`, `retry_exhausted`, and `dead_letter`.
  - Tracks chunk statuses including recovery states.
  - Supports strict LLM JSON extraction when an LLM client is supplied.
  - Falls back to deterministic workflow/pitfall/decision heuristics with
    degraded `ok_with_fallback` status.
  - Routes stored output as `digest-candidate` rows with
    `source=openclaw-native-digest`, `state=pending`, and candidate lifecycle.
- `cli.ts`
  - Adds `digest report`, `digest run`, and `digest recovery` routes.
  - Keeps `digest run` dry-run by default and requires `--apply` for writes.
- `src/experience-tools.ts`
  - Registers `scope_recall_digest_report`, `scope_recall_digest_run`, and
    `scope_recall_digest_recovery` behind management-tool config signals.
- `src/operator-dashboard.ts` and `cli.ts`
  - Surface native digest status, candidate debt, and recovery needs.
- `tests/digest-pipeline.test.mjs`
  - Covers dry-run extraction, candidate-only writes, unsafe chunk filtering,
    and recovery scheduling.

## Verification

Required verification for this phase:

```bash
node --test tests/digest-pipeline.test.mjs
npm run typecheck
npm run build
npm run release:gate
```

Release gate now checks digest source markers, manifest tool contracts,
response contracts, and live extension drift for `src/digest-pipeline.ts` and
`dist/src/digest-pipeline.js`.

## Audit Findings

- Digest output does not directly become confirmed durable fact memory.
- Unsafe chunks are skipped at chunk scope, not by hiding the whole run.
- Degraded heuristic extraction is visible through `ok_with_fallback`.
- Failed chunks are inspectable and can be moved to `pending_recovery`.

## Remaining Risk

- This baseline does not install an always-on scheduler. Operators must invoke
  digest explicitly or wire a separate cron after evaluating risk.
- LLM extraction quality still depends on the configured provider. The pipeline
  fails closed to no opaque raw transcript summaries, but commercial deployments
  should add workload-specific fixtures before raising capture aggressiveness.
