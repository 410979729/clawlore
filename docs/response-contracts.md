# Scope Recall Response Contracts

Status: Phase 1 contract baseline.

Operator JSON responses must be stable enough for release gates, live smoke
checks, and external dashboards. Field additions are allowed when backwards
compatible. Field removals or type changes require a schema version bump and
changelog entry.

## Common Rules

- JSON output must be a single object written to stdout after any OpenClaw CLI
  wrapper warnings.
- Mutating commands must include `dry_run` or `dryRun` when preview mode exists.
- Reports should include `status` when unsupported or degraded paths are valid.
- Error arrays should be arrays of strings or structured objects.
- Previews should redact secrets, raw logs, and private paths unless the path is
  an explicit operator argument.

## `doctor`

Command:

```bash
openclaw scope-recall doctor --json --quiet
```

Required fields:

- `ok`: boolean.
- `issues`: string array.
- `sqlTruth`: object with `available`, `path`, `count`, `fts`, and `error`.
- `fts`: object with `available` and `lastError`.
- `vectorCompanion`: object with readiness fields plus `drift`.
- `scopes`: object with `configured`, `sqlTruthCounts`, `vectorCounts`,
  `sqlVectorScopeMatch`, and `warnings`.
- `categories`: record of category counts.
- `experience`: Experience Kernel health object.
- `nightlyDigest`: legacy digest/journal health object with a `native`
  OpenClaw-native digest sub-object when available.

Exit code is 0 when `ok` is true and non-zero when `ok` is false or command
execution fails.

## `dashboard`

Command:

```bash
openclaw scope-recall dashboard --json
```

Required fields:

- `ok`: boolean.
- `version`: plugin version string.
- `summary`: memory rows, FTS status, governance debt, journal recovery status,
  candidate debt, graph hygiene status, freshness status/debt, digest
  status/debt, and Experience status.
- `sections`: at least `fts`, `governance_cleanup`, `journal_recovery`,
  `memory_candidate_promotion`, `graph_hygiene`, `freshness`, `digest`,
  `experience`, and `vector`.

Commercial target: dashboard marks top-level `ok: false` when doctor-critical
vector drift, freshness debt, digest initialization/recovery debt, digest
candidate debt, or missing Experience Kernel readiness exists.

## `repair-vectors`

Commands:

```bash
openclaw scope-recall repair-vectors --dry-run --json
openclaw scope-recall repair-vectors --apply --json
```

Required fields:

- `dryRun`: boolean.
- `truthCount`: SQL truth row count.
- `vectorRowsBefore`: vector companion row count before repair.
- `staleVectorRowsDeleted`: count of stale vector rows deleted or that would be
  deleted.
- `processed`: number of SQL truth rows processed.
- `rebuilt`: number of vector rows rebuilt or that would be rebuilt.
- `skipped`: number of rows skipped because embedding or validation failed.
- `errors`: string array.

Contracts:

- Default mode is dry-run.
- `--dry-run` wins over `--apply`.
- `rebuilt` increments once per row, not once per batch.
- Limited runs must not prune stale vector rows outside the limit.

Commercial target: add a narrow missing/stale repair mode and progress output
for large stores.

## OpenClaw Digest

Commands:

```bash
openclaw scope-recall digest report --json
openclaw scope-recall digest run --dry-run --json
openclaw scope-recall digest run --apply --json
openclaw scope-recall digest recovery --dry-run --json
```

Required report fields:

- `status`: `not_initialized`, `ready`, or `needs_recovery`.
- `runs`: total and by-status counts for `openclaw_digest_runs`.
- `chunks`: by-status counts and failed chunk count.
- `candidate_debt`: count of digest-created memories still in candidate
  lifecycle.
- `failed_runs`: count of parse/retry/dead-letter runs.

Run responses include:

- `dry_run`: boolean.
- `status`: one of `ok`, `ok_with_fallback`, `empty`, `filtered`,
  `parse_error`, `retry_exhausted`, or `dead_letter`.
- `run_id`: stable run id for audit.
- `source`: chunk/source summary.
- `extracted`, `stored`, `skipped`, and `errors`.
- `candidates`: strict candidate objects plus chunk ids and optional stored ids.

Contracts:

- Default mode is dry-run.
- `--dry-run` wins over `--apply`.
- Digest output never writes directly as confirmed facts; write mode stores
  candidate-only memories with `source=openclaw-native-digest`.
- Unsafe or empty chunks produce chunk-scoped skip records, not opaque durable
  summaries.

## Governance Cleanup

Commands:

```bash
openclaw scope-recall governance cleanup --dry-run --json
openclaw scope-recall governance rollback --batch-id <id> --dry-run --json
openclaw scope-recall governance audit-coverage --json
```

Cleanup and rollback responses include:

- `dry_run`: boolean.
- `batch_id`: string when a lifecycle batch is involved.
- Candidate/mutation counts appropriate to the route.
- Audit or rollback metadata for applied writes.

Audit coverage includes:

- `status`.
- `audit_events`.
- `by_event_type`.
- `by_action`.
- `archived_rows_with_batch`.

## Candidate Promotion

Commands:

```bash
openclaw scope-recall candidates report --json
openclaw scope-recall candidates apply --dry-run --json
```

Required fields:

- `status`.
- `candidate_count`.
- `by_action`.
- `by_scope`.
- `by_source`.
- `samples` with redacted previews.
- `truncated`.

Apply responses also include mutation counts and batch metadata.

## Journal Recovery

Command:

```bash
openclaw scope-recall journal recovery --dry-run --json
```

Required fields:

- `status`: `ready`, `unsupported`, or degraded status.
- `candidate_count`.
- `reason_prefixes`.
- `missing_tables` when unsupported.
- `by_reason`.
- `by_scope`.
- `items`.

Unsupported journal tables are valid for OpenClaw today and must be explicit.

## Graph Hygiene

Command:

```bash
openclaw scope-recall graph hygiene --dry-run --json
```

Required fields:

- `ok`: boolean.
- `status`: `ready`, `unsupported`, or degraded status.
- `reason` when unsupported.
- `counts` for orphan and hidden-lifecycle graph companion rows.
- Applied responses should include before/after counts.

## Forgetting

Commands:

```bash
openclaw scope-recall forgetting report --json
openclaw scope-recall forgetting run --dry-run --json
```

Report fields:

- `total_rows`.
- `active_rows`.
- `soft_archive_candidates`.
- `hard_delete_candidates`.
- `duplicate_groups`.

Run fields:

- `dry_run`.
- `archived`.
- `deleted`.
- `hard_delete_blocked` when vector companion cleanup prevents a destructive
  write.

## Experience

Commands:

```bash
openclaw scope-recall experience stats --json
openclaw scope-recall experience promote --dry-run --json
openclaw scope-recall experience replay --playbook-id <id> --json
openclaw scope-recall playbooks list --json
```

Stats include `episodes`, `playbooks`, and `runs`.

Promotion includes:

- `dry_run`.
- `episodes_scanned`.
- `playbooks_created`.
- `playbooks_promoted`.
- `playbooks_needing_review`.

Playbook lifecycle commands must identify the target playbook, lifecycle
action, and resulting status.

## Experience Replay

Command:

```bash
openclaw scope-recall experience replay --playbook-id <id> --cases benchmarks/experience-replay-cases.json --json
```

Required fields:

- `status`: `ok`, `failed`, or `schema_missing`.
- `playbook_id`.
- `cases_file`.
- `passed`, `failed`, and `total`.
- `results`: array of per-case objects with `case_id`, `case_name`,
  `coverage_ratio`, `hits`, `misses`, `negative_hits`, and `details`.

Contracts:

- Replay is read-only.
- Replay cases are bounded static fixtures.
- Negative terms must fail a case rather than being silently ignored.

## Benchmark

Command:

```bash
node scripts/golden-benchmark.mjs
```

Required fields:

- `ok`: boolean.
- `name`: benchmark suite id.
- `summary`: aggregate metrics object with:
  - `totalCases`.
  - `expectedIds` and `expectedHits`.
  - `knownAnswerRecall`.
  - `topKAccuracy`.
  - `forbiddenViolations` and `forbiddenViolationRate`.
  - `latencyMs` with `avg`, `p50`, `p95`, and `max`.
  - `promptBudget` with `cases`, `hitRate`, and `exceeded`.
  - `filterCounts` with scope and inactive-filter counts.
- `cases`: array with `name`, returned `ids`, expected/forbidden ids, missing
  expected ids, forbidden violations, latency, prompt-budget data, and a
  stage-level trace.

The benchmark must fail when an expected id is missing, a forbidden id appears,
the minimum expected rank is missed, or a case exceeds its prompt budget.
