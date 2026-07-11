# OpenClaw Scope Recall Commercial Memory Plugin Plan

Date: 2026-06-30

Status: planning document only. This file does not claim implementation
completion.

## Goal

Build `scope-recall-openclaw` into a boutique, mature, commercial-grade memory
plugin for OpenClaw.

The goal is not to copy Yuheng's Hermes plugin file-for-file. Yuheng's
`scope-recall` 1.6.0 is the reference implementation for mature memory
contracts, safety posture, governance, and release quality. OpenClaw must adopt
the contracts that matter to users and operators, then implement them in
OpenClaw-native TypeScript, OpenClaw dynamic tools, OpenClaw session hooks,
OpenClaw config, npm/ClawHub packaging, and live extension deployment.

## Product Principles

1. SQLite truth remains authoritative; vector, graph, FTS, reports, and
   summaries are rebuildable companions.
2. Recall must be current-turn relevant, scoped, explainable, and bounded.
3. Memory writes are conservative. Raw turns and tool traces are provenance
   first, durable memory only after quality gates.
4. Mutating operations are dry-run first unless the command itself is an
   explicit lifecycle action.
5. Forgetting defaults to soft archive with audit receipts and rollback.
6. A commercial plugin needs operator visibility: doctor, dashboard, release
   gates, response contracts, and live smoke checks.
7. Runtime parity must be evidence-backed. A command existing is not enough;
   behavior, state transitions, and failure modes must be tested.
8. OpenClaw-specific UX wins over superficial Hermes API-name parity.

## Non-Goals

- Do not copy Hermes Python files into the OpenClaw plugin.
- Do not implement Hermes-only packaging such as wheel install as a first-class
  OpenClaw feature.
- Do not claim full parity while OpenClaw lacks behavior tests and live probes.
- Do not turn auto-capture, smart extraction, or background digest into
  aggressive default-on behavior for public installs.
- Do not make a large rewrite before establishing contracts and regression
  gates.

## Current Baseline

OpenClaw currently has:

- SQLite truth, FTS diagnostics, LanceDB vector companion, and sqlite-bruteforce
  fallback.
- `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, and
  optional management tools.
- Experience Kernel primitives and selected operator tools.
- Dry-run-first vector repair and SQLite busy timeout alignment.
- Some Yuheng 1.6.0 operator CLI routes.
- A release gate, vector repair smoke, and a small golden benchmark.

Known gaps:

- No complete OpenClaw contract matrix equivalent.
- Scope isolation is not proven across Telegram chats, threads, users, agent
  identities, and workspace boundaries.
- Recall Funnel evidence and commercial recall-quality metrics are not complete.
- Fact freshness and relation-aware recall are not first-class.
- Nightly digest / long-term workflow digestion is not yet productized as an
  OpenClaw-native pipeline.
- Doctor/dashboard do not yet cover the full health model: freshness,
  extraction, journal, digest, graph, candidate debt, Experience quality, and
  live drift.
- Tests are much thinner than Yuheng's reference line.
- Release readiness is not yet strong enough for a mature commercial memory
  product.

## Target Capability Contract

### User-Facing Memory

- Durable user/project/ops/memory facts persist across authorized OpenClaw
  sessions for the same canonical user and agent identity.
- Local scratch and temporary chat context do not bleed across unrelated chats,
  users, groups, threads, or agents.
- Retrieval combines lexical, vector, metadata, temporal, relation, and
  freshness signals while keeping scope filters authoritative.
- Recall output includes enough evidence for the agent to answer responsibly
  without dumping private paths, raw logs, or tool traces.

### Operator-Facing Governance

- Operators can inspect memory health, candidate debt, vector drift, FTS drift,
  graph hygiene, freshness debt, digest failures, and Experience playbook debt.
- Cleanup, repair, recovery, promotion, and forgetting have dry-run previews,
  audit events, batch ids, and rollback where meaningful.
- Hard delete is guarded and fails closed when vector companion cleanup cannot
  be verified.

### Release-Facing Quality

- Each major contract has source files, tests, dynamic probes, and release gate
  checks.
- Public package artifacts exclude node_modules, databases, logs, backups,
  credentials, and local runtime state.
- Workspace source and live extension drift are checked before saying a live
  instance uses a feature.

## Phases And Steps

The plan has 8 phases and 42 implementation steps.

### Phase 0 - Stabilize Baseline And Stop Over-Claiming

Purpose: prevent more false parity claims before new work starts.

Steps:

1. Update docs to state the current 1.0.26 line is partial OpenClaw-native
   parity, not full function parity.
2. Add a short release note explaining which 1.6.0 concepts are adopted and
   which are intentionally not claimed.
3. Snapshot current workspace and live extension status.
4. Run the existing release gate and live doctor to establish a baseline.
5. Decide whether to keep 1.0.26 as an internal line or cut the next work as
   1.1.0.

Files likely touched:

- `CHANGELOG.md`
- `README.md`
- `docs/parity-roadmap.md`
- `docs/runtime-maturity-audit-*.md`

Exit criteria:

- The docs no longer imply full Yuheng 1.6.0 parity.
- Existing tests and release gate pass without new feature work.

### Phase 1 - Write OpenClaw Contract Matrix

Purpose: convert the commercial memory plugin into a contract-driven project.

Steps:

6. Create an OpenClaw contract matrix modeled after Yuheng's contract matrix.
7. Define contract rows for tool surface, scope isolation, SQLite truth,
   retrieval, context budgets, capture/admission, digest, Experience,
   governance, secret index, packaging, and live rollout.
8. For each row, list primary files, tests, dynamic probes, and release gates.
9. Add response contract docs for JSON outputs from doctor, dashboard, repair,
   cleanup, benchmark, digest, and Experience.
10. Add a configuration reference mapping OpenClaw config keys to defaults,
    risk level, and restart requirement.

Files likely touched:

- `docs/openclaw-contract-matrix.md`
- `docs/response-contracts.md`
- `docs/configuration.md`
- `scripts/release-gate.mjs`

Exit criteria:

- Every future feature can point to a contract row before code is changed.
- Release gate checks that required docs exist.

### Phase 2 - Scope, Identity, And Admission Control

Purpose: make memory boundaries commercially trustworthy before improving
recall intelligence.

Steps:

11. Audit OpenClaw runtime context fields available in Telegram, CLI, direct
    sessions, groups, and subagents.
12. Define canonical identity and scope rules for OpenClaw: user, agent,
    workspace, chat, thread, platform, and local scratch.
13. Harden `memory_store`, auto-capture, smart extraction, and reflection writes
    so each write gets deterministic scope metadata.
14. Add admission-control gates for low-value ACKs, wrappers, tool dumps,
    attachment markers, private paths, secrets, and ephemeral progress noise.
15. Add tests proving cross-user, cross-chat, cross-thread, cross-agent, and
    local-scratch isolation.

Files likely touched:

- `src/scopes.ts`
- `src/identity-addressing.ts`
- `src/admission-control.ts`
- `src/capture-safety.ts`
- `src/tools.ts`
- `src/smart-extractor.ts`
- `tests/*scope*.test.mjs`
- `tests/capture-safety*.test.mjs`

Exit criteria:

- Foreign-scope rows cannot be recalled or injected.
- Local scratch requires explicit inclusion.
- Public default capture remains conservative.

### Phase 3 - Commercial Retrieval And Recall Funnel

Purpose: make recall quality measurable instead of anecdotal.

Steps:

16. Build a structured Recall Funnel trace for each retrieval: source pool,
    lexical candidates, vector candidates, metadata filters, scope filters,
    rerank inputs, final returned ids, timing, and prompt budget use.
17. Extend `memory_explain_rank` or add an OpenClaw-native explain surface with
    rank-aligned evidence.
18. Expand golden benchmark fixtures with known-answer, forbidden-id,
    entity/project isolation, archived-row exclusion, and stale-fact cases.
19. Add aggregate benchmark metrics: latency percentiles, top-k accuracy,
    known-answer recall, forbidden-id violations, prompt-budget hit rate, and
    filter counts.
20. Add release-gate enforcement for the commercial benchmark.

Files likely touched:

- `src/retriever.ts`
- `src/retrieval-trace.ts`
- `src/retrieval-stats.ts`
- `src/tools.ts`
- `scripts/golden-benchmark.mjs`
- `benchmarks/golden-recall-cases.json`
- `tests/*retrieval*.test.mjs`

Exit criteria:

- Bad recall can be debugged from a trace.
- Release gate fails when known-answer recall regresses.

### Phase 4 - Fact Freshness And Relation-Aware Recall

Purpose: reduce stale, contradictory, and isolated memory failures.

Steps:

21. Add fact freshness metadata for durable factual memories: observed_at,
    valid_until, freshness_status, live-check-needed, and source confidence.
22. Add dashboard/doctor visibility for stale or live-check-needed facts.
23. Add relation extraction for owned-by, affects, depends-on, supersedes,
    same-topic, contradicts, and contextualizes.
24. Persist relation companion rows or a compatible OpenClaw graph layer while
    keeping SQL truth authoritative.
25. Add relation-aware rerank hooks with conservative defaults and explain
    evidence.
26. Add graph hygiene repair for orphan, hidden-lifecycle, and contradiction
    review rows.

Files likely touched:

- `src/sql-truth-store.ts`
- `src/smart-metadata.ts`
- `src/conflict-governance.ts`
- `src/graph-hygiene.ts`
- `src/retriever.ts`
- `src/operator-dashboard.ts`
- `src/tools.ts`
- `tests/*freshness*.test.mjs`
- `tests/*relation*.test.mjs`
- `tests/governance-alignment.test.mjs`

Exit criteria:

- Freshness debt is visible.
- Relation evidence can improve or penalize recall without bypassing scope.
- Contradictions create reviewable evidence rather than silent overwrites.

### Phase 5 - OpenClaw-Native Digest And Long-Term Memory Distillation

Purpose: turn conversation history into durable, high-density memory without
polluting recall.

Steps:

27. Decide the OpenClaw-native source of digest input: session events,
    reflection event store, journal-compatible staging tables, or a new
    provider-owned journal layer.
28. Implement digest run ledgers with statuses such as ok, ok_with_fallback,
    empty, filtered, parse_error, retry_exhausted, and dead_letter.
29. Add LLM extraction with strict schemas, timeout handling, fallback metadata,
    and chunk-scoped skip semantics.
30. Add heuristic fallback for workflow/pitfall/decision extraction, with clear
    degraded status.
31. Route digest output through the same admission, scope, freshness, relation,
    and candidate-promotion gates as manual writes.
32. Add CLI routes and tools for digest report, digest dry-run, digest run, and
    digest recovery.

Files likely touched:

- `src/reflection-event-store.ts`
- `src/reflection-store.ts`
- `src/task-experience.ts`
- `src/experience-promotion.ts`
- `src/llm-client.ts`
- new `src/digest-*.ts`
- `src/operator-dashboard.ts`
- `cli.ts`
- `tests/*digest*.test.mjs`

Exit criteria:

- Digest never writes opaque raw transcript summaries as durable facts.
- Failed or degraded digest runs are visible to doctor/dashboard.
- Digest-created memories remain candidates unless quality gates promote them.

### Phase 6 - Experience Kernel Productization

Purpose: make reusable procedural memory actually useful in OpenClaw work.

Steps:

33. Audit current Experience tables and tools against OpenClaw task/session
    events.
34. Strengthen playbook creation gates: failed, blocked, incomplete, low-signal,
    or unsafe traces cannot auto-promote.
35. Add duplicate playbook detection, review queues, supersede flows, and
    feedback counters.
36. Add Experience replay benchmark fixtures for common OpenClaw workflows:
    config change, gateway recovery, vector repair, release gate, plugin
    rollout, and Telegram delivery.
37. Make preflight packets bounded and scope-filtered so they help without
    taking over the prompt.

Files likely touched:

- `src/experience-store.ts`
- `src/experience-promotion.ts`
- `src/experience-replay.ts`
- `src/experience-tools.ts`
- `src/task-experience.ts`
- `tests/experience-kernel.test.mjs`
- new `benchmarks/experience-replay-cases.json`

Exit criteria:

- Useful playbooks can be searched, inspected, reviewed, promoted, superseded,
  and replay-tested.
- Bad or stale playbooks become visible debt, not hidden prompt pollution.

### Phase 7 - Operator, Packaging, And Commercial Release Hardening

Purpose: make the plugin installable, inspectable, and releasable.

Steps:

38. Extend doctor and dashboard to cover all contracts: SQL, FTS, vector,
    scope, recall quality, freshness, graph, digest, governance, Experience,
    secrets, and workspace/live drift.
39. Add stable JSON schema versions for operator reports.
40. Add package scan checks for credentials, local paths, databases, logs,
    backups, `node_modules`, and generated runtime state.
41. Add CI template coverage for test, typecheck, build, smoke, benchmark, and
    release gate.
42. Add live rollout SOP: backup live extension, sync package, run inspect,
    run doctor, run CLI smoke, run live tool discovery, run one safe recall
    probe, and record evidence.

Files likely touched:

- `src/operator-dashboard.ts`
- `cli.ts`
- `scripts/release-gate.mjs`
- `docs/github-actions-ci-template.yml`
- `docs/operator-runbook.md`
- `docs/release-readiness-template.md`
- `README.md`

Exit criteria:

- A release can be inspected from source, package artifact, and live runtime.
- Operators can tell whether the live install is healthy or degraded.
- No release statement depends on model self-report or unverified assumptions.

## Version Cadence

Suggested version line after the 1.0.26 partial-parity work:

- `1.1.0`: contract matrix, docs, scope/admission tests, and no-overclaim
  cleanup.
- `1.2.0`: Recall Funnel, explain output, benchmark expansion, and retrieval
  quality gates.
- `1.3.0`: fact freshness, relation-aware recall, graph hygiene, and dashboard
  visibility.
- `1.4.0`: OpenClaw-native digest and recovery pipeline.
- `1.5.0`: Experience Kernel productization and replay benchmarks.
- `1.6.0`: commercial release hardening, packaging, live rollout SOP, and
  release readiness docs.

The numbering does not have to match Hermes. It should communicate OpenClaw's
own product maturity.

## Implementation Discipline

For each phase:

1. Start with docs and contract rows.
2. Add focused tests before or with behavior changes.
3. Implement the smallest OpenClaw-native behavior slice.
4. Run targeted tests.
5. Run `npm test`, `npm run typecheck`, `npm run build`, and
   `npm run release:gate` when the phase touches runtime behavior.
6. Sync to live extension only after source gates pass.
7. Verify live with plugin inspect, doctor, dashboard, and a safe smoke probe.
8. Update changelog, roadmap, and release-readiness notes.

## Acceptance Bar For "Commercial Grade"

The plugin can be described as commercial-grade only when:

- Recall quality has benchmark evidence, not just anecdotal success.
- Scope isolation has negative tests for cross-user/chat/thread/agent bleed.
- Mutating maintenance operations have dry-run, audit, and rollback where
  meaningful.
- Stale facts, contradictions, digest failures, vector drift, and candidate debt
  are visible.
- Live extension status is verified after deployment.
- Release artifacts are clean and reproducible.
- Documentation clearly separates current guarantees from roadmap items.

## Immediate Next Step

Do Phase 0 and Phase 1 first. They are not glamorous, but they prevent false
claims and make later engineering work reviewable. After that, Phase 2 and
Phase 3 should be prioritized because scope safety and measurable recall
quality are the foundation of a mature memory product.
