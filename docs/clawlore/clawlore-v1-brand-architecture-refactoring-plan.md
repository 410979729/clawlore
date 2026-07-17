# ClawLore v1 brand and architecture refactoring plan

Status: active implementation plan  
Started: 2026-07-17  
Scope: source candidate only; no live deployment, config mutation, database
mutation, Gateway restart, repository push, tag, or release is authorized by
this plan.

## Outcome

ClawLore becomes one coherent OpenClaw memory product in naming, code layout,
runtime configuration, documentation, and operator surfaces. Historical Scope
Recall identities remain only where an explicit compatibility contract requires
them. The implementation becomes a maintainable modular monolith whose entry
point performs composition and registration rather than business logic.

This is a behavior-preserving refactor unless a phase names an independently
reviewed behavior change. Existing SQL truth, FTS, vector, relations,
Experience, governance, security, migration, rollback, and release guarantees
must remain intact throughout the work.

## Baseline and diagnosis

The 2026-07-17 source inventory at documentation HEAD `13a836d` found:

- `index.ts`: 4,757 lines;
- `cli.ts`: 2,794 lines;
- `src/tools.ts`: 2,727 lines;
- `src/store.ts`: 2,076 lines;
- `src/experience-tools.ts`: 1,732 lines;
- `src/sql-truth-store.ts`: 1,514 lines;
- `src/smart-extractor.ts`: 1,427 lines;
- `src/retriever.ts`: 1,425 lines;
- `src/embedder.ts`: 1,309 lines.

The first whole-source line-budget run also found five operator modules above
the 800-line target that the root-only inventory had missed:

- `src/v2/operator/live-candidate-duplicate-archive.ts`: 1,171 lines;
- `src/v2/operator/live-candidate-unsafe-trace-rewrite-apply.ts`: 1,011 lines;
- `src/v2/operator/live-candidate-companion-disposition.ts`: 880 lines;
- `src/v2/operator/live-post-assignment-candidate-plan.ts`: 807 lines;
- `src/v2/operator/live-candidate-durable-rewrite-apply.ts`: 805 lines.

All listed hotspots now have executable non-growth ceilings. New TypeScript
modules may not exceed 800 lines.

The project is not an unstructured codebase: it has strict TypeScript, a large
regression suite, reproducible package gates, SQL authority checks, privacy
controls, and an inward dependency test for `src/v2`. The structural debt is
nevertheless real:

1. The canonical package and plugin id are ClawLore, while `clawloreV2`,
   `clawlore-v2:` log prefixes, and the `src/v2` root still present ClawLore as
   an attached subsystem.
2. `index.ts` contains reflection, capture classification, transcript reading,
   Markdown retrieval, configuration parsing, runtime construction, and hook
   behavior in addition to dependency composition.
3. CLI and Agent-tool modules combine command schemas, policy, rendering,
   persistence calls, and registration for many unrelated capabilities.
4. The executable dependency-direction test covers only `src/v2`; most legacy
   root modules are not assigned to a declared layer.
5. Some comments document important invariants and failure boundaries, while
   others preserve migration-era wording or describe mechanics already obvious
   from the code. Comment presence is not yet a reliable contract signal.

These findings mean the code is maintainable today because verification is
strong, but change cost and regression risk will continue to grow unless the
composition boundary is reduced and the two architecture generations are
converged.

## Naming policy

### Canonical product surfaces

- Product: `ClawLore`
- npm package: `clawlore`
- OpenClaw plugin id and config root: `clawlore`
- Primary CLI: `openclaw clawlore`
- Runtime and diagnostic log prefix: `clawlore:`
- Default extension, data, and OAuth locations: `clawlore`
- Current architecture configuration: `runtime`

### Compatibility surfaces

The following names may remain only behind exported compatibility constants,
manifest declarations, migration adapters, or tests that prove compatibility:

- legacy plugin id `scope-recall-openclaw`;
- CLI aliases `scope-recall` and `memory-pro`;
- stable `scope_recall_*` dynamic-tool wire ids;
- old data and OAuth fallback paths;
- old source tags and persisted task/event values;
- deprecated configuration input `clawloreV2` during one compatibility period;
- historical reports and migration fixtures whose captured names must not be
  rewritten.

New code, logs, docs, fixtures, temporary paths, and internal task types must
not introduce new Scope Recall branding. Compatibility use must state why it
cannot yet be removed.

## Target architecture

ClawLore remains a modular monolith with this dependency direction:

```text
domain <- application/ports <- adapters + infrastructure + operator
                              ^
                              |
                         composition root
```

- `domain/`: data contracts and invariants without OpenClaw, filesystem,
  database, or provider dependencies.
- `application/`: use cases and ports; authorization and lifecycle decisions
  happen here once.
- `adapters/openclaw/`: host events, identity evidence, tool/CLI input mapping,
  and response rendering.
- `infrastructure/`: SQLite truth, FTS/vector/relation projections, files,
  providers, locks, and OAuth persistence.
- `operator/`: diagnostics, backup, migration, repair, review, and release
  controls. These are not default Agent tools.
- `compat/`: explicitly temporary adapters for old ids, data, configuration,
  commands, and persisted formats.
- `index.ts`: parse through the configuration module, construct dependencies,
  and register adapters. It contains no capture, retrieval, SQL, migration,
  transcript, backup, or reflection algorithms.

Physical moves from `src/v2` happen incrementally after import-direction and
characterization tests exist. A bulk directory rename is forbidden.

## Comment standard

Comments are required when they preserve information the type system and code
cannot express clearly:

- security, privacy, authorization, or trust-boundary invariants;
- transaction ordering, crash consistency, locks, and rollback semantics;
- compatibility reason, owner, and removal condition;
- non-obvious OpenClaw lifecycle constraints;
- public API behavior that callers must not infer from implementation detail.

Comments that merely restate the next statement, describe stale phases, use
ambiguous `V1/V2` product language, or claim behavior not covered by a test are
removed or corrected. Exported contracts receive concise TSDoc where the name
and types do not already communicate the contract.

## Execution phases

### A. Canonical brand and compatibility ledger

1. Add canonical and compatibility identity constants.
2. Introduce `runtime` as the canonical architecture/runtime config object.
3. Accept `clawloreV2` only as a deprecated fallback; canonical input wins and
   conflicting dual input fails closed.
4. Change current runtime log prefixes and new fixture/temp names to ClawLore.
5. Teach task classification and documentation to recognize ClawLore first.
6. Add a source audit that rejects unexplained new legacy-brand occurrences.

Acceptance: package/manifest/CLI/config/log identity tests pass; legacy aliases
continue to load; no current runtime path presents ClawLore as `clawlore-v2`.

### B. Characterization and whole-source architecture guard

1. Inventory every source module into domain, application, adapter,
   infrastructure, operator, compat, or composition.
2. Extend executable dependency checks beyond `src/v2`.
3. Add a maintainability budget: no new production module above 800 lines and
   no existing hotspot may grow without an explicit exception and split plan.
4. Add characterization tests before moving logic from a hotspot.

Acceptance: every production TypeScript module is classified; forbidden
reverse imports fail tests; hotspot baselines can only stay flat or shrink.

### C. Thin composition root

Extract from `index.ts` in bounded slices:

1. configuration types, parsing, and canonical/legacy config resolution;
2. reflection transcript reading and reflection orchestration;
3. auto-capture policy and conversation-state handling;
4. Markdown compatibility retrieval;
5. core runtime construction;
6. OpenClaw hook registrars grouped by capability.

Each extraction preserves public exports through a temporary compatibility
re-export where tests or consumers require it. The eventual entry-point budget
is at most 800 lines, with no business algorithm or storage statement.

### D. CLI and Agent-tool decomposition

Split CLI and tools by capability: core memory, lifecycle, diagnostics,
Experience, governance, migration/repair, OAuth, and self-improvement. Command
builders translate input/output; application services own decisions. Shared
authorization and error contracts must not be copied into each command.

Acceptance: command registration remains byte/shape compatible where public;
operator-only capabilities remain undiscoverable to ordinary Agents; focused
tool and CLI tests plus packed OpenClaw smoke pass.

### E. Storage and retrieval boundaries

1. Reduce `MemoryStore` to a compatibility facade over explicit truth,
   projection, and transaction ports.
2. Separate SQL authority/migration, vector companion, FTS, and file privacy
   adapters without weakening atomicity.
3. Move retrieval planning/ranking away from storage implementation details.
4. Keep vector and relations rebuildable from SQL truth and outbox.

Acceptance: authority, transaction-fault, restart, privacy, vector-repair,
recall, and migration suites remain green after every slice.

### F. Architecture-generation convergence

Move stable `src/v2` domain/application/adapters/storage modules into canonical
non-versioned roots one bounded capability at a time. Persisted schema names,
receipts, migration identifiers, and historical records retain their versions.
Product code stops using `V2` when it means “current ClawLore”; `V2` remains
only where it names an actual data/schema/protocol version.

Acceptance: no duplicate legacy/current implementation owns the same decision;
the compatibility layer has a documented removal ledger.

### G. Comment and documentation audit

Review every changed public contract and every security/transaction boundary.
Update architecture maps, configuration, operator runbook, compatibility
ledger, and handoff. Historical evidence reports remain immutable apart from
factual link corrections.

### H. Release and deployment decision

Run focused tests after every bundle and the complete Linux source gate at each
phase boundary. Run the exact Node 24 Windows gate and clean only owned test
roots before release acceptance. A live identity switch remains a separate,
backup-backed transaction with rollback and real-channel verification.

## Verification ladder

Every implementation bundle runs, in order:

1. formatting/diff check and focused characterization tests;
2. TypeScript typecheck and build;
3. affected security, storage, retrieval, tool, or runtime suites;
4. module/brand architecture audits;
5. full test suite;
6. vector repair, recall, scale, packed runtime/LanceDB/OpenClaw smokes, SBOM,
   supply-chain audit, and release gate when the bundle touches release code;
7. Windows Node 24 gate for a release candidate.

No bundle is complete until its run report, this plan, `TODO-clawlore.md`, the
project handoff, and the current daily log agree.

## First bounded bundle

The first implementation bundle is deliberately narrow:

- establish the plan and baseline;
- add canonical runtime-config identity and a deprecated compatibility alias;
- remove `clawlore-v2:` from current logs;
- make new task classification ClawLore-first without rewriting persisted old
  values;
- add focused brand/config tests and a dated run report;
- do not move large modules yet.

This creates the contract needed for later structural work without mixing a
brand migration with a high-risk entry-point split.

## Second bounded bundle

The second bundle starts Phase B closure and the first Phase C slice:

- enforce the target dependency direction across migration-era root modules;
- keep the 45 baseline reverse edges in an exact shrink-only ledger;
- document the dominant missing ports and remediation order;
- characterize plugin configuration defaults, validation, compatibility, and
  error behavior before changing the entry point;
- move the validated `PluginConfig` contract and parser into
  `src/plugin-config.ts` as composition support;
- preserve the public `parsePluginConfig` export from `index.ts`;
- reduce the `index.ts` non-growth ceiling from 4,730 to 4,184 lines;
- do not combine this slice with reflection, capture, Markdown retrieval,
  runtime construction, hook registration, or any live rollout.

Acceptance requires parser parity fixtures, focused configuration and
architecture tests, strict typecheck/build, the complete test suite, and the
full Linux source release gate. Exact evidence belongs in the dated bundle-2
run report rather than in this stable execution plan.

## Third bounded bundle

The third bundle completes the reflection-specific Phase C slice without
changing capture, recall injection, runtime construction, or live state:

- move the reflection error/generation contracts into a dependency-free domain
  module;
- move transcript filtering, redaction, JSONL reading, reset fallback, and
  previous-session recovery into a characterized OpenClaw adapter;
- move prompt construction, embedded-runner loading, timeout/retry handling,
  and structured fallback generation into a separate adapter;
- move `command:new` / `command:reset` recovery, generation, file writing,
  mapped-memory persistence, reflection-store persistence, and daily-log
  recording behind explicit ports in one command orchestrator;
- keep error collection, inherited/derived prompt injection, session caches,
  and hook registration in the composition root for a later hook-registrar
  slice;
- preserve the public transcript-reader export and all existing hook names,
  priorities, log contracts, storage metadata, and fail-closed access checks;
- reduce the `index.ts` non-growth ceiling from 4,184 to 3,336 lines without
  adding a reverse-dependency exception.

Acceptance requires transcript/reset fixtures, embedded success/fallback
fixtures, denied and successful command-orchestration fixtures, source
governance, strict typecheck/build, the complete regression suite, and both
evidence-write and normal-mode Linux source gates. Exact identities and counts
belong in the dated bundle-3 run report.

## Fourth bounded bundle

The fourth bundle extracts auto-capture policy and bounded conversation state
without moving scope resolution, smart extraction, storage, or hook ownership:

- move compatibility regex signals, exclusions, and category classification
  into a domain policy module while preserving the public `index.ts` exports;
- move ingress/session key alignment, user/optional-assistant message
  normalization, pending-ingress consumption, history cursors, recent-context
  carry-forward, and bounded-map eviction into one application state module;
- characterize repeated agent-end delivery as zero new text when the normalized
  snapshot has not grown, while treating a shorter reset snapshot as new input;
- keep access resolution, rate limiting, low-value policy, compression, smart
  extraction, regex persistence, Markdown dual-write, and hook registration in
  the composition root for later bounded slices;
- reduce the `index.ts` non-growth ceiling from 3,336 to 3,105 lines without
  adding a reverse-dependency exception.

Acceptance requires policy compatibility fixtures, ingress/session-key and
message-shape fixtures, pending-ingress/repeated-snapshot/history-growth tests,
bounded-state verification, source governance, strict typecheck/build, the
complete regression suite, and both evidence-write and normal-mode Linux
source gates. Exact identities and counts belong in the dated bundle-4 report.
