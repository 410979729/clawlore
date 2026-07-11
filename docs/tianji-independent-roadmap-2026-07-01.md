# Tianji Scope Recall Independent Roadmap - 2026-07-01

## Decision

Tianji's `scope-recall-openclaw` will no longer track Yuheng's Scope Recall as
a lockstep parity target. The two implementations may still borrow proven
features from each other, but Tianji's plugin should optimize for OpenClaw's
runtime shape, Telegram/Discord operational boundaries, current workspace
knowledge governance, and the needs of one main operator instance.

The product direction is an OpenClaw Experience Kernel:

- recall facts when they are useful;
- explain why recall happened;
- preserve SQL truth as the authoritative layer;
- keep vector search as a rebuildable companion index;
- turn successful verified work into procedural playbooks;
- promote durable truth to Markdown or skills only after review.

## Current Baseline

Observed for this planning turn:

- live `plugins.slots.memory` points to `scope-recall-openclaw`;
- live extension path is
  `/home/a/openclaw-tianji/home/state/extensions/scope-recall-openclaw`;
- package version is `1.1.0`;
- Gateway service is active/running and `/healthz` returns live;
- the shell used by this task does not have `openclaw` on `PATH`, so live CLI
  verification must use the instance app binary or an explicit path.

Existing strengths:

- SQL truth, FTS, and vector companion are already separated;
- capture safety exists for common wrapper, tool replay, and secret-like noise;
- retrieval tracing and rank explanation primitives already exist;
- Experience Kernel tables and tools already exist;
- deterministic replay fixtures exist for playbook quality gates;
- release gate exists.

Known gaps:

- promoted playbooks are still far fewer than raw candidates and reflections;
- the operator can see counts, but not enough actionable promotion debt;
- auto-recall explainability is not yet a first-class operator audit trail;
- project/customer/channel scope boundaries are not yet mature enough for
  broad multi-context use;
- some maturity docs still describe parity with Hermes/Yuheng instead of
  Tianji's independent OpenClaw direction.

## Non-Goals

- Do not become a full chat transcript archive.
- Do not treat vector rows as the source of truth.
- Do not blindly copy Yuheng features when OpenClaw needs different behavior.
- Do not auto-promote high-risk procedural memories into skills or Markdown.
- Do not add background mutation paths that bypass the store API.

## Design Principles

1. Truth before index.
   SQL truth remains authoritative. FTS and vector stores are companions that
   must be repairable from SQL truth.

2. Explain before trust.
   Retrieval and auto-injection should leave enough trace data to answer:
   what was recalled, why it ranked, which scope it came from, and whether it
   was suppressed or filtered.

3. Procedure before trivia.
   The highest-value memories are not loose facts. They are reusable procedures
   with triggers, prerequisites, steps, verification gates, pitfalls, cleanup,
   and scope limits.

4. Scoped by default.
   Agent, project, channel, customer machine, and collaboration context should
   eventually influence recall. Cross-scope recall should be explicit and
   explainable.

5. Safety is part of storage.
   Secret-like values, wrappers, tool replay text, fallback transcripts, and
   low-value reflections should be blocked or quarantined before they become
   long-term recall material.

6. Markdown remains durable truth.
   Scope Recall can recommend promotion, but stable human-readable truth belongs
   in `USER.md`, `MEMORY.md`, `knowledge/**`, or approved skills.

## Workstreams

### A. Runtime And Health Truth

Goal: make operators prove the live plugin is healthy without reading stale
docs.

Planned changes:

- keep `doctor`, `stats`, and `release:gate` as first-line commands;
- add operator-facing summaries for Experience Kernel debt;
- make release gate check new governance entry points;
- avoid requiring Gateway restart for read-only CLI improvements.

### B. Recall Explainability

Goal: make recall observable enough to debug bad or missing injections.

Planned changes:

- expose a compact auto-recall trace ledger;
- connect `memory_debug_retrieval` and `memory_explain_rank` outputs to a
  stable CLI/operator workflow;
- record filter reasons for suppressed memories;
- add tests for redacted trace output.

### C. Experience Governance

Goal: make the episode-to-playbook promotion chain continuous.

Planned changes:

- add an Experience debt report that classifies completed episodes,
  candidate/reviewed/promoted playbooks, stale candidates, and review backlog;
- make the report read-only by default and JSON-stable for cron or dashboards;
- later add guided promotion batches with dry-run, backup, and review gates;
- keep high-risk playbooks in `needs_review` until a human promotes them.

### D. Scope Boundaries

Goal: reduce cross-topic and cross-customer bleed.

Planned changes:

- formalize scope dimensions: agent, project, channel, customer host, and task
  class;
- teach recall tools to show when a result crossed a scope boundary;
- add policy gates before cross-scope recall is injected automatically;
- keep the current `agent:main` shared behavior as the compatibility baseline.

### E. Safety And Pollution Control

Goal: prevent long-term memory from being dirtied by operational wrappers,
tool transcripts, provider secrets, or low-value reflections.

Planned changes:

- keep all writes on the store API path;
- extend capture safety tests when new wrappers or channels appear;
- add stronger promotion-time scans before any Markdown, playbook, or skill
  proposal is generated;
- prefer reversible soft archive over hard delete.

### F. Promotion To Human Truth

Goal: bridge Scope Recall to maintained knowledge without making it a prompt
dump.

Planned changes:

- add review queues for "already covered", "needs segmentation", "promote to
  knowledge", and "promote to skill";
- require truth dedupe against `knowledge/**` before new docs are proposed;
- use Skill Workshop only when the target artifact is a reusable skill.

## Phase Plan

### Phase 0 - Current Turn, Closed Loop

Deliver a small but real independent-roadmap slice:

1. write this roadmap file;
2. add a read-only Experience governance debt report;
3. expose it through `openclaw scope-recall experience debt`;
4. add focused tests for the report;
5. run typecheck, build, focused tests, and release gate or document the
   blocker;
6. avoid Gateway restart unless a live runtime mutation requires it.

Acceptance:

- the roadmap file exists under plugin docs;
- `experience debt --json` returns stable fields;
- the report distinguishes ready-to-promote successful episodes, stale
  candidate playbooks, review backlog, and failing/quarantined playbooks;
- tests pass for empty and populated Experience Kernel states;
- release gate still passes or any failure is explained with evidence.

### Phase 1 - Recall Transparency

Add a recall explain ledger:

- retain compact trace metadata for auto-recall decisions;
- include redacted memory IDs, rank reasons, scope, category, and filter status;
- expose a read-only CLI command;
- add tests proving secrets and wrappers are not emitted.

### Phase 2 - Promotion Workflow

Turn debt into controlled action:

- add dry-run promotion batches from completed episodes;
- require backup hints for mutation commands;
- track batch IDs and reviewer notes;
- add replay checks before promotion to `promoted`.

### Phase 3 - Scope Policy

Make scope handling explicit:

- add project/channel/customer scope metadata helpers;
- default to current-agent/current-channel recall;
- make cross-scope recall opt-in or clearly labeled;
- add regression tests for customer-machine isolation.

### Phase 4 - Knowledge And Skill Bridge

Create reviewed outbound promotion:

- generate knowledge-draft candidates, not direct truth writes;
- dedupe against existing Markdown truth;
- route skill-worthy workflows through Skill Workshop proposals;
- leave an audit trail linking source episode, playbook, and final artifact.

## Execution Status - 2026-07-01 Follow-up

Phase 0 is closed by the Experience governance debt report.

Phase 1 is implemented by `src/auto-recall-ledger.ts`, runtime hook recording
in `index.ts`, and the read-only `scope-recall recall-trace` CLI command. The
ledger stores redacted query previews, hashed memory references, rank reasons,
scope/category metadata, filter status, and cross-scope counts; it does not
store memory text or raw memory IDs.

Phase 2 is implemented by `src/experience-promotion-batch.ts` and
`scope-recall experience promotion-batch`. The command is dry-run-first, dry
runs do not mutate storage, and apply runs record batch IDs, reviewer notes,
item rows, and backup guidance.

Phase 3 is implemented by `src/scope-policy.ts`, the `scope-recall
scope-policy evaluate` CLI command, and auto-recall governance filtering. Global
and same-scope recall remain compatible; project/channel/customer/task
cross-scope injection requires explicit opt-in through
`autoRecallAllowCrossScope=true`.

Phase 4 is implemented by `src/knowledge-skill-bridge.ts` and
`scope-recall experience bridge-drafts`. The bridge generates reviewed
knowledge/skill draft candidates, dedupes against supplied Markdown truth, and
can record SQL draft audit rows without writing Markdown truth or applying Skill
Workshop proposals.

## Verification Standard

For code changes:

- `npm test` or focused `node --test ...`;
- `npm run typecheck`;
- `npm run build`;
- `npm run release:gate`;
- read-only live `doctor` when CLI access is available.

For memory mutations:

- dry-run first;
- backup SQL/WAL/SHM before applying;
- rerun `doctor`;
- report row deltas and any retained backup path.

For docs:

- no secrets, tokens, private keys, cookies, or provider credentials;
- no stale claim that Tianji must remain in lockstep with Yuheng;
- state whether the doc is roadmap, audit, or historical record.
