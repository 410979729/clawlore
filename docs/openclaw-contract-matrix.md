# OpenClaw ClawLore Contract Matrix

Status: Phase 1 contract baseline.

This matrix defines the OpenClaw-native capability contract for
ClawLore. It is not a Yuheng/Hermes file-for-file checklist.
Each row identifies the user/operator contract, primary implementation files,
minimum tests, dynamic probes, release-gate hooks, and current maturity.

Status values:

- `ready`: source, tests, docs, and live probes exist.
- `partial`: behavior exists but coverage, docs, or live probes are incomplete.
- `planned`: contract is accepted, but implementation is not complete.
- `hermes-only`: useful reference, not claimed for OpenClaw.

| Contract | Promise | Primary Files | Required Tests | Dynamic Probes | Release Gate | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Tool surface | Public OpenClaw tools are registered only when config gates allow them. | `index.ts`, `src/tools.ts`, `src/experience-tools.ts`, `openclaw.plugin.json` | `tests/safety-regressions.test.mjs`, `tests/experience-kernel.test.mjs` | `openclaw plugins inspect clawlore` | Manifest tool contract checks | `partial` |
| Operator CLI | CLI routes are dry-run-first where mutating and JSON-capable where automatable. | `cli.ts`, `dist/cli.js`, `README.md` | `tests/safety-regressions.test.mjs`, `tests/governance-alignment.test.mjs` | `doctor --json`, `dashboard --json`, route help smoke | CLI marker checks, pack dry-run | `partial` |
| SQLite truth authority | SQLite truth remains canonical; vector, FTS, graph, reports, and mirrors are rebuildable companions. | `src/store.ts`, `src/sql-truth-store.ts`, `src/sqlite-vector-store.ts` | `tests/sql-truth-authority.test.mjs`, `scripts/smoke-vector-repair.mjs` | doctor SQL/FTS/vector drift report | Required files, smoke repair, busy timeout checks | `partial` |
| Scope isolation | Recall and operator actions do not cross user, chat, thread, workspace, or agent scope unless explicitly authorized. | `src/scopes.ts`, `src/identity-addressing.ts`, `src/clawteam-scope.ts`, `src/tools.ts`, `docs/runtime-identity-scope-rules.md` | `tests/safety-regressions.test.mjs`, future cross-chat/thread fixtures | safe recall probe from isolated scopes | Runtime identity doc marker, future live probe gate | `partial` |
| Identity addressing | Stored rows carry deterministic user/agent/workspace/chat/thread/platform metadata where runtime provides it. | `src/runtime-scope-metadata.ts`, `src/identity-addressing.ts`, `src/scopes.ts`, `src/tools.ts`, `src/smart-extractor.ts` | `tests/safety-regressions.test.mjs` | runtime-context capture probe | Runtime metadata contract checks | `partial` |
| Capture safety | ACKs, wrappers, tool dumps, attachment markers, private credential paths, progress noise, and secret-shaped content are rejected or sanitized before durable storage. | `src/capture-safety.ts`, `src/admission-control.ts`, `src/smart-extractor.ts`, `src/tools.ts` | `tests/capture-safety*.test.mjs`, `tests/safety-regressions.test.mjs` | `memory_store` negative smoke | Existing safety tests | `partial` |
| Admission control | Smart extraction writes pass utility, confidence, novelty, recency, and type-prior gates. | `src/admission-control.ts`, `src/admission-stats.ts`, `src/smart-extractor.ts` | Admission and rejected-audit tests | dashboard/admission debt probe | Future admission gate | `partial` |
| Retrieval quality | Recall combines lexical, vector, metadata, temporal, relation, and freshness signals while respecting scope filters. | `src/retriever.ts`, `src/retrieval-trace.ts`, `src/retrieval-stats.ts`, `scripts/golden-benchmark.mjs`, `benchmarks/golden-recall-cases.json` | Golden benchmark expected/forbidden/scope/stale cases plus future retrieval tests | safe recall probe, benchmark JSON | Golden benchmark aggregate metrics gate | `partial` |
| Recall Funnel trace | Every recall can explain source pool, candidates, filters, rerank inputs, final ids, timing, and prompt budget use. | `src/retrieval-trace.ts`, `src/retrieval-stats.ts`, `src/tools.ts`, `scripts/golden-benchmark.mjs` | Benchmark stage trace plus future rank-aligned trace tests | `memory_debug`, `memory_explain_rank`, benchmark trace output | Benchmark trace markers, future full funnel gate | `partial` |
| Context budgets | Auto-recall and preflight packets stay bounded by item count, char budget, per-item budget, and repeated-recall suppression. | `src/auto-recall-query.ts`, `src/tools.ts`, `src/experience-replay.ts`, `src/experience-tools.ts` | Auto-recall and Experience preflight tests | session auto-recall smoke | Existing tests plus future budget gate | `partial` |
| Fact freshness | Durable factual memories carry observed/validity metadata and surface stale/live-check-needed debt. | `src/smart-metadata.ts`, `src/sql-truth-store.ts`, `src/operator-dashboard.ts` | `tests/governance-alignment.test.mjs`, future dedicated freshness fixtures | dashboard freshness section | Dashboard freshness markers, future doctor gate | `partial` |
| Relation-aware recall | Relation evidence can boost, penalize, contextualize, or flag contradictions without bypassing scope. | `src/conflict-governance.ts`, `src/graph-hygiene.ts`, `src/retriever.ts`, `src/tools.ts` | `tests/retrieval-relation.test.mjs`, `tests/conflict-governance.test.mjs` | graph hygiene and explain probes | Relation evidence trace/test gate | `partial` |
| Governance cleanup | Cleanup, rollback, candidate promotion, graph hygiene, journal recovery, forgetting, and playbook lifecycle actions are auditable. | `src/governance-cleanup.ts`, `src/candidate-promotion.ts`, `src/graph-hygiene.ts`, `src/journal-recovery.ts`, `src/forgetting.ts`, `src/experience-tools.ts` | `tests/governance-alignment.test.mjs` | CLI dry-run/apply JSON probes | Governance marker checks | `partial` |
| Forgetting and hard delete | Soft archive is default; hard delete fails closed if vector companion cleanup cannot be verified. | `src/forgetting.ts`, `src/tools.ts`, `src/experience-tools.ts` | Governance and Experience tests | forgetting report/run dry-run | Existing hard-delete tests | `ready` |
| Digest and distillation | Long conversation history becomes high-density candidates through strict schemas, chunk-scoped skip semantics, visible run ledgers, and candidate-only writes that stay behind promotion gates. | `src/digest-pipeline.ts`, `src/reflection-event-store.ts`, `src/reflection-store.ts`, `src/experience-tools.ts`, `cli.ts` | `tests/digest-pipeline.test.mjs` | `digest report/run/recovery`, `scope_recall_digest_*`, dashboard digest section | Digest markers, tests, docs, and drift checks | `ready` |
| Experience Kernel | Successful tool-backed procedures become bounded, reviewed, searchable playbooks with replay evidence and feedback counters. | `src/experience-store.ts`, `src/experience-promotion.ts`, `src/experience-replay.ts`, `src/experience-tools.ts`, `src/task-experience.ts`, `benchmarks/experience-replay-cases.json` | `tests/experience-kernel.test.mjs`, `tests/task-experience.test.mjs` | experience stats/preflight/replay probes | Replay fixture, CLI markers, and tests | `ready` |
| Secret index | Secret location/indexing remains opt-in, plaintext values are not stored in SQL/FTS/vector, and schemas stay hidden by default. | `src/secret-index.ts`, `src/tools.ts`, `openclaw.plugin.json` | `tests/safety-regressions.test.mjs` | tool discovery with default/enabled config | Manifest config signal checks | `ready` |
| Packaging hygiene | Public artifacts exclude runtime databases, logs, backups, credentials, `node_modules`, and local state. | `package.json`, `scripts/release-gate.mjs` | release gate pack inspection | `npm pack --dry-run --json` | Path-based pack scan gate | `ready` |
| Live rollout | Source and live extension are compared before live claims, then inspect, doctor, dashboard, and safe recall probes record evidence. | `scripts/release-gate.mjs`, `docs/operator-runbook.md`, `docs/release-readiness-template.md` | release gate drift checks | inspect/doctor/dashboard/safe recall | Expanded drift subset and rollout docs | `partial` |

## Phase Dependencies

Phase 2 must close scope isolation and identity metadata before Phase 3 improves
recall intelligence. Phase 3 must make recall measurable before Phase 4 adds
freshness and relation-aware ranking. Phase 7 is not just packaging; it is the
point where all previous contracts become live-verifiable.

## Current Contract Gaps

- Scope isolation now has agent-scope negative tests and runtime metadata
  contracts, but still lacks live Telegram direct/group/thread/subagent probes.
- Dashboard does not surface doctor vector drift as a top-level degraded state.
- Vector repair can rebuild all rows for a one-row drift and needs a narrow
  missing/stale path with progress output.
- Commercial aggregate benchmark metrics are release-gated; full runtime Recall
  Funnel traces still need source-pool/rerank/prompt-budget parity in live
  explain surfaces.
- Freshness and relation-aware recall now have partial OpenClaw behavior; they
  still need richer doctor visibility and operator-facing explain output.
- OpenClaw-native digest is release-gated as a conservative, explicit-run,
  candidate-only pipeline. It is not an always-on scheduler.
- Experience replay is release-gated with static OpenClaw workflow fixtures;
  future work can add end-to-end transcript replay and outcome scoring.
