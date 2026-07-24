# ClawLore Design

ClawLore is the OpenClaw runtime port of the scope-recall storage model. It keeps long-term memory auditable by separating the durable truth store from the semantic retrieval companion.

## Goals

- Keep SQLite as the canonical truth layer.
- Treat vector storage as a rebuildable companion.
- Keep a native-free vector backend available for hosts where LanceDB cannot load safely.
- Support OpenClaw dynamic tools and CLI commands without depending on Hermes plugin APIs.
- Fail open on recall and fail closed on unsafe capture.
- Keep release packages small, public, and free of runtime state.

## Runtime Shape

The plugin entrypoint is `dist/index.js`. That wrapper loads `index.ts` through `jiti`, so the published package can keep TypeScript source available while remaining loadable by OpenClaw's JavaScript plugin runtime.

OpenClaw integration surfaces:

- Dynamic tools: `memory_recall`, `memory_store`, `memory_forget`, `memory_update`.
- Optional management tools for stats, debug, listing, compaction, and rank explanation.
- CLI commands: `openclaw clawlore` and compatibility aliases
  `openclaw scope-recall` and `openclaw memory-pro`.
- Session hooks for auto-recall, auto-capture, reflection, session recovery, and self-improvement review.
- A receipt-gated native ContextEngine for final V2 recall cutover. Its
  registered engine id is the canonical plugin id `clawlore`, matching
  `plugins.slots.contextEngine`.

## V1 to V2 authority transition

V1 and V2 are not intended to remain co-authoritative. V1 is authoritative
during shadow, remains a compatibility and rollback lane during `v2-write`,
and stops serving normal recall when the native V2 ContextEngine enters
receipt-gated `cutover`. V1 is retained read-only for a bounded rollback window
while new store operations remain dual-written, and may leave the runtime only
after the cutover preflight reports
`v1RetirementReady: true`. Historical V1 material then remains accessible only
through explicit migration or archive tooling.

The transition never infers ownership or lifecycle from row presence. Unknown
principals, candidate or archived rows, unverified content, V1/V2 divergence,
projection drift, and pending outbox work all block cutover or retirement.

## Storage Layers

SQLite stores the authoritative memory rows, categories, metadata, FTS rows, and audit-friendly state. The vector companion stores rows derived from SQLite. LanceDB is the default production backend; `sqlite-bruteforce` stores vectors in a separate SQLite database and scans them locally for native-free compatibility. If the vector companion is stale, missing, or dimension-mismatched, operators should rebuild it from SQL truth rather than treat it as a second source of truth.

Hosted embedding providers are recommended for semantic quality. `local-hash` exists for no-key bootstrap, testability, and offline availability. It produces deterministic lexical hash vectors and is intentionally documented as an availability fallback rather than a high-quality semantic model.

The intended repair loop is:

```bash
openclaw clawlore doctor --json --quiet
openclaw clawlore repair-vectors --dry-run
openclaw clawlore repair-vectors
openclaw clawlore doctor --json --quiet
```

## Capture Safety

Capture is conservative. Secret-like text, credentialed URLs, bearer tokens, and password assignments are rejected before persistence. Recall failures should not block the main model response; unsafe write paths should stop before touching SQL truth.

## Package Boundary

The repository is a source and release package, not a live OpenClaw state dump. `npm pack` must include source, docs, manifest, scripts, tests, and the dist wrapper, but must exclude:

- `node_modules/`
- `.git/`
- databases and vector stores
- logs
- backups and temporary directories
- local `.env` files

`npm run release:gate` enforces the most important packaging and registration checks.

## Relationship To Hermes Scope Recall

This plugin shares the storage philosophy of Hermes `scope-recall`, but it is not a direct file copy. OpenClaw has different plugin APIs, command registration, dynamic tools, and session hooks. Hermes-only user-facing surfaces are tracked in `docs/parity-roadmap.md` instead of being claimed as complete parity.
