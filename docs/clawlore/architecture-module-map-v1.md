# ClawLore v1 architecture module map

Status: source architecture closure candidate; ready for independent audit
after the complete Linux gate passes. This is not a live deployment claim.

## Dependency direction

The intended inward direction is:

```text
OpenClaw entry points and adapters
              |
              v
application policies, use cases, and ports
              |
              v
domain and versioned persisted contracts

infrastructure implements application ports
operator modules call application/infrastructure through explicit policy
index.ts only constructs dependencies and registers capabilities
```

`tests/clawlore-source-governance.test.mjs` classifies every production
TypeScript module, rejects forbidden direction changes, prevents new files over
800 lines, and holds inherited hotspots to shrink-only budgets. The exact
reverse-dependency exception ledger fell from 45 to 44 edges in the closure
bundle.

## Composition and host lifecycle

| Surface | Owner | Boundary |
|---|---|---|
| `index.ts` | composition root | Parse config, construct dependencies, and register capabilities; no SQL, retrieval, transcript, capture, or reflection algorithm. |
| `src/core-memory-runtime.ts` | runtime construction | Core stores, retriever, embedder, policies, and lifecycle cleanup. |
| `src/runtime-shadow-registration.ts` | rollout composition | Canonical shadow/runtime wiring through the OpenClaw adapter layer. |
| `src/auto-recall-hooks.ts` | recall host adapter | Prompt-time recall lifecycle and bounded query/cache behavior. |
| `src/auto-capture-hooks.ts` | capture host adapter | Capture event orchestration; policy and session state remain separate. |
| `src/reflection-hooks.ts` | reflection host adapter | Reflection command and prompt lifecycle registration. |
| `src/task-experience-hooks.ts` | Experience host adapter | Task/episode lifecycle registration. |
| `src/self-improvement-hooks.ts` | self-improvement host adapter | Review/extraction lifecycle registration. |

The root entry point is 632 lines, down from the 4,730-line baseline and below
the 800-line target.

## Application and OpenClaw adapter layer

Stable current-product modules now live under canonical roots:

- `src/application/`: context composition, identity resolution, legacy address
  mapping, policy decisions, and support-bundle contracts;
- `src/adapters/openclaw/`: compatibility context sources, native/legacy shadow
  retrieval, runtime composition, rollout control, and runtime shadowing;
- `src/markdown-compat.ts` and `src/markdown-mirror.ts`: bounded compatibility
  retrieval and mirrored Markdown persistence, including path-containment
  checks;
- `src/plugin-config.ts`: canonical configuration parsing and conflict-checked
  legacy input resolution.

The corresponding former `src/v2/application`, `src/v2/adapters/openclaw`, and
`src/v2/operator/support-bundle.ts` paths are deprecated re-export shims only.
Current code may import `src/v2` only for actual versioned contracts such as
`MemoryAddressV2`, `ContextPackV1`, and release/migration receipts.

## CLI and Agent capability adapters

`cli.ts`, `src/tools.ts`, and `src/experience-tools.ts` are stable facades.
Capability implementation is separated as follows:

- CLI: auth, runtime policy, diagnostics, Experience, governance, memory, and
  migration commands under `src/cli/`;
- memory tools: recall, write, lifecycle, diagnostics, governance, and
  self-improvement modules, sharing `src/tool-runtime-policy.ts`;
- Experience tools: episode, playbook, query, operator, and review modules,
  sharing `src/experience-tool-runtime-policy.ts`.

`tests/public-module-contract.test.mjs` locks the pre-split runtime exports.
Ordinary Agents still receive only the intended query-safe surface; management
and operator capabilities retain their existing authorization/discoverability
gates.

## Storage, retrieval, and projections

`src/memory-store-ports.ts` defines truth, retrieval, projection, and
transaction ports. `src/memory-store-facade.ts` provides the compatibility
facade and `src/store.ts` retains the existing runtime implementation. The
split changes construction and ownership boundaries, not atomicity, rollback,
privacy, vector-debt, or SQL-authority behavior.

SQL remains authoritative. FTS, vectors, relations, and Markdown are
rebuildable or compatibility projections. Retrieval planning/ranking remains
outside SQL mutation code.

## Remaining controlled hotspots

Audit-ready does not mean zero technical debt. These inherited files remain
over 800 lines and are locked by exact non-growth budgets:

| File | Lines | Disposition |
|---|---:|---|
| `src/store.ts` | 2,010 | Runtime implementation behind the new store ports/facade; split further only under transaction-fault characterization. |
| `src/sql-truth-store.ts` | 1,514 | SQL authority and migration-sensitive infrastructure. |
| `src/smart-extractor.ts` | 1,427 | Extraction/provider pipeline. |
| `src/retriever.ts` | 1,425 | Hybrid retrieval and ranking. |
| `src/embedder.ts` | 1,309 | Provider/OAuth/embedder infrastructure. |
| `src/experience-store.ts` | 1,072 | Experience truth/FTS/receipt transactions. |
| `src/digest-pipeline.ts` | 825 | Digest orchestration. |
| `src/llm-oauth.ts` | 810 | OAuth persistence and callback security. |

Five versioned operator/migration modules also remain above 800 lines. They
are not current-product naming debt; they are high-risk, receipt-bound operator
flows and remain shrink-only. Any future split must preserve their existing
backup, receipt, idempotency, and rollback tests.

## Audit focus

Independent review should concentrate on public export parity, hook lifecycle
ordering, management-tool discoverability, store-port fidelity, deprecated
shim purity, path containment in Markdown compatibility reads, and the 44-edge
reverse-dependency ledger. Release acceptance additionally requires the exact
Windows Node 24 gate and a separately authorized live rollout.
