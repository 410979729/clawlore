# ClawLore migration-era root dependency debt v1

Status: active shrink-only ledger  
Baseline: 2026-07-17 architecture bundle 2

## Purpose

ClawLore's migration-era root modules are classified by predominant
responsibility, but they do not yet obey the target inward dependency direction.
This document explains the debt; the exact machine-enforced edge list lives in
`tests/clawlore-source-governance.test.mjs` as
`ROOT_REVERSE_DEPENDENCY_DEBT`.

The executable contract is strict:

- a new forbidden edge fails the source-governance test;
- an existing edge cannot silently change target or direction;
- when a debt edge is removed, its ledger entry must be removed in the same
  reviewed change;
- type-only imports count as dependencies because they still couple module
  contracts;
- `index.ts` and `src/plugin-config.ts` are composition modules and may wire
  concrete implementations; business modules may not use that exception.

## Baseline

The initial scan found 137 internal imports among classified root modules and
their current-architecture dependencies. Forty-five violate the target layer
direction.

| Reverse direction | Edges | Meaning |
|---|---:|---|
| application → infrastructure | 19 | Use cases construct or call concrete store, embedder, LLM, or Experience persistence APIs |
| application → operator | 7 | Runtime decisions depend on operator/redaction modules |
| adapters → infrastructure | 8 | Agent tools call concrete persistence and filesystem modules directly |
| adapters → operator | 4 | Agent tools depend directly on dashboards, recovery, or diagnostic rendering |
| infrastructure → operator | 6 | Storage/provider code imports diagnostic or support-bundle behavior from the outward operator layer |
| domain → infrastructure | 1 | `noise-prototypes.ts` depends on the concrete embedder |

The highest-fan-in debt targets are:

- `src/diagnostic-redaction.ts`: 14 reverse edges;
- `src/store.ts`: 11 reverse edges;
- `src/embedder.ts`: 6 reverse edges;
- `src/llm-client.ts`: 5 reverse edges;
- `src/experience-store.ts`: 2 reverse edges.

This concentration is useful: the project does not have 45 unrelated design
failures. Most debt comes from a few missing ports and one cross-cutting
diagnostic boundary.

## Remediation order

1. Split redaction policy and stable error contracts from operator-facing
   diagnostic rendering. Domain/application/infrastructure code may depend on
   the inward contract; operator output remains outward.
2. Introduce application ports for memory truth/transactions, embedding, LLM,
   and Experience persistence. Concrete implementations are supplied only by
   composition.
3. Change Agent tools and CLI capability modules to call application services
   instead of `MemoryStore`, embedder, files, or operator dashboards directly.
4. Move noise-prototype embedding behind an application port so the domain no
   longer imports infrastructure.
5. Remove the infrastructure-to-operator support-bundle edge by moving the
   shared receipt contract inward and keeping rendering in operator code.

Each step is a separate characterized bundle. The ledger is not permission to
add more debt, and it is not evidence that an edge is safe merely because it is
listed.

## Bundle-2 composition slice

The first `index.ts` extraction moved host configuration validation and
normalization into `src/plugin-config.ts`. That module owns:

- the validated `PluginConfig` contract;
- privacy-first default normalization;
- embedding credential shape validation;
- numeric bounds and legacy session compatibility;
- canonical `runtime` plus deprecated config-alias resolution;
- reflection and task-experience configuration defaults.

`index.ts` retains only composition-time use of the parsed contract and a
compatibility re-export of `parsePluginConfig`. The slice introduces no new
reverse dependency because configuration parsing is explicitly part of the
composition boundary.
