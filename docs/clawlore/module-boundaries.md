# ClawLore v1 Module Boundaries (V2 Data Architecture)

ClawLore remains a modular monolith. Modules communicate through typed ports;
they do not share hidden database handles or call entry-point helpers.

## Dependency direction

```text
domain <- application ports/services <- adapters / storage / workers / operator
```

- `domain/`: pure contracts and invariants; no infrastructure imports.
- `application/`: use cases and ports; may depend only on `domain/` and other
  application modules.
- `storage/`: SQL truth adapter implementing application ports. SQL is the
  durable runtime truth.
- `workers/`: outbox consumers. FTS, vector, and relations are independent,
  rebuildable projections and may not mutate SQL truth outside application
  services.
- `adapters/openclaw/`: OpenClaw lifecycle and rendering translation only.
- `migration/`: preview/apply/rollback orchestration; never imported by the hot
  runtime path.
- `operator/`: backup, restore, repair, policy, and migration control plane;
  never exposed as default Agent tools.
- `eval/`: deterministic comparison and quality evaluation only.

## Preserved capabilities

- SQLite truth, immutable revisions, sources, ACL, audit events, and outbox.
- FTS lexical retrieval.
- Vector semantic retrieval and reranking.
- Relation/graph projection and conflict evidence.
- Experience episodes, reviewed playbooks, replay, and feedback.
- Governance, repair, forgetting, and rebuild operations in the operator plane.

FTS, vector, and relations must be rebuildable from SQL truth plus outbox. They
must never become a second truth source or perform authorization after data has
already crossed a scope boundary.

## Entry-point rule

`index.ts` may parse configuration, construct dependencies, and register
adapters/tools/hooks. Business algorithms, SQL statements, migration logic,
backup logic, and projection implementations do not belong in `index.ts`.

The module-boundary test rejects reverse dependencies such as application ->
storage or domain -> application.

The fixture-only OpenClaw runtime composition root stays inside the adapter
layer and receives retrieval/trace dependencies through typed injection. It may
normalize runtime requests and register host observers, but it may not import a
concrete storage adapter, migration, backup, operator mutation, or projection
implementation. A shadow observer must return no prompt mutation and must fail
open on timeout or trace persistence failure.
