# Phase 4A Memory Center run — 2026-07-12

## Scope

This isolated slice adds a read-only Memory Center application model over the
Truth V2 port. It does not create a second database, dashboard server, Agent
tool, live hook, or mutation path.

The model exposes:

- ACL-filtered active knowledge and why it was remembered;
- ContextPack items used this turn and why they were recalled;
- candidate/disputed review inbox entries;
- correction receipts, current conflicts, and stale facts;
- scope counts and projection convergence health;
- declared embedding/rerank/extraction egress routes;
- the already-implemented encrypted snapshot and reviewed-playbook capabilities.

## Security and correctness evidence

- The same SQL prefilter predicate protects memory rows, events, relations, and
  projection health before they leave storage.
- Private data from another principal and conversation data from another target
  are absent from all Memory Center views.
- A ContextPack for another actor is rejected.
- ContextPack items absent from the actor's accessible SQL rows are suppressed.
- Conflict relations must join both endpoints through their current revisions;
  historical superseded revisions do not appear as current conflicts.
- Only active, non-disputed, non-expired endpoints may appear as conflicts.
- Provider egress declarations are normalized and deduplicated without exposing
  credentials.

## Verification

- `npm run smoke:clawlore-memory-center`: 2/2 PASS.
- `npm run smoke:clawlore-module-boundaries`: 2/2 PASS.
- `npm test`: 134/134 PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run smoke:vector-repair`: PASS.
- `node scripts/golden-benchmark.mjs`: known-answer recall 1.0; top-k accuracy
  1.0; forbidden violations 0; prompt budget exceeded 0.
- `npm run release:gate`: PASS; pack scan 299 files.

The first regression after adding a superseded-revision conflict fixture failed
because the old assertion still expected one correction event. The fixture now
correctly expects and verifies both auditable corrections; all gates were rerun.

## Live boundary

No live extension, configuration, database, prompt hook, ContextEngine slot, or
Gateway service was changed or restarted.

## Next slice

Implement the Phase 5 subagent/Experience lifecycle: isolated/fork snapshots,
child candidate-only writes, parent verification, promotion/quarantine lineage,
and replay gates. Keep it behind application ports and fixture-only tests.
