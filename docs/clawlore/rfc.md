# RFC: ClawLore v1 (V2 Data Architecture)

Status: proposed implementation baseline  
Date: 2026-07-11

## Product contract

ClawLore is an OpenClaw-native, local-first, explainable, correctable, and
governable memory and verified-experience engine. It must answer five questions
for every durable item: who owns it, who may see it, why it is trusted, how it
is corrected or forgotten, and whether the capability belongs to the Agent or
the Operator plane.

## Existing assets retained

- SQLite remains the runtime truth; FTS and vectors remain rebuildable views.
- Conservative capture, soft archive, forgetting, repair, freshness, conflict,
  relations, Experience episodes/playbooks, dry-run, batch ids, dashboard, and
  release gates are retained.
- Human-maintained Markdown and approved skills remain the human truth layer.
- The 1.x package id, manifest id, CLI aliases, data paths, tool aliases, and
  source tags remain compatible during the transition.

## Architecture target

1. A thin OpenClaw adapter resolves identity and policy, delegates context
   composition, and exposes a small Agent facade.
2. Application services own remember, correction, forgetting, retrieval,
   context composition, and distillation semantics.
3. SQLite stores revisions, sources, ACL, events, current state, and a
   transactional projection outbox.
4. FTS, vectors, relations, summaries, and caches are rebuildable projections.
5. CLI and the future Memory Center call the same application services.

## Delivery decisions

- Compatibility hooks ship before any ContextEngine takeover.
- ContextEngine remains opt-in until transcript assembly, compaction, timeout,
  abort, cache, and subagent behavior pass dedicated tests.
- The first slice is Memory Address V2 + Identity Resolver + Policy Decision.
- New v2 tables are additive. No legacy row is rewritten or deleted by preview.
- A modular monolith is the initial deployment; worker/RPC separation is a
  future scaling option, not a Phase 1 requirement.
- Operator functionality leaves default Agent discovery, but core Experience
  query/preflight may remain behind the Agent facade when tool availability and
  scope match.

## Explicit non-goals for the first release

- No live database migration, Gateway restart, ContextEngine slot selection,
  package rename, data-directory move, destructive compaction, automatic
  Markdown mutation, or remote-provider requirement.
- No claim that target SLOs are currently measured guarantees.

## Phase order

1. Phase 0: RFC, ADR, migration design, executable address slice.
2. Phase 1: thin adapter, unified compatibility Context Composer, core facade.
3. Phase 2: revision/event/source/ACL/outbox truth model and migration preview.
4. Phase 3: unified distillation and candidate review.
5. Phase 4: Memory Center and explainability.
6. Phase 5: verified Experience and subagent lifecycle.
7. Phase 6: commercial release, compatibility, rollback drills, packaging.
