# ClawLore

Scoped long-term memory for OpenClaw: SQLite truth, hybrid recall, conservative capture, and rebuildable vector indexes that can survive native dependency trouble.

## Core Guarantees

- Keeps SQLite as the durable source of truth.
- Treats vector indexes as rebuildable companions, never as the only copy.
- Retrieves through hybrid vector + BM25 search with optional reranking.
- Keeps capture conservative and rejects common secret-shaped text before persistence.
- Supports LanceDB for production vector retrieval and `sqlite-bruteforce` when native dependencies are unsafe.
- Supports hosted semantic embeddings and deterministic `local-hash` vectors for bootstrap, tests, and no-key availability.
- Exposes OpenClaw tools and operator commands through the canonical `openclaw clawlore` command.
- Keeps `openclaw scope-recall` and `openclaw memory-pro` as compatibility
  aliases for existing operators.

## Privacy Defaults

Public installs default to conservative behavior:

- `autoCapture` is off until an operator explicitly enables it.
- `smartExtraction` is off until an operator opts in to LLM-based extraction.
- `autoBackup` is a deprecated no-op retained for configuration compatibility. Keep it `false`; `true` makes `clawlore doctor` report an issue and never creates a backup. Use the encrypted snapshot/export operator flow instead.
- Hosted embeddings and reranking can send text to configured providers. Use `local-hash`, local endpoints, or disabled reranking for sensitive deployments.
- `memory_forget` requires `confirm: true` for deletion; query mode returns candidates first.
- External memory access is principal-bound by default. Private chats use a
  hashed `user:` scope; group/channel memory is denied unless an operator
  explicitly selects isolated per-conversation scopes. Shared `agent:` and
  `global` reads require an exact migration allowlist or explicit opt-in.
- The secret-index tool never accepts plaintext secret values. An optional
  fingerprint must be a SHA-256 digest produced locally by a trusted vault or
  client helper before the tool call.

## Lineage

This plugin grew out of the earlier LanceDB Pro / `memory-lancedb-pro` memory work. That lineage is still visible in the rebuildable vector companion, SQL truth migration path, and the `openclaw memory-pro` compatibility alias.

It is no longer just a rename of that project. As OpenClaw's scoped-memory requirements matured, this package moved onto a different route: ClawLore treats SQLite as the canonical truth layer, LanceDB as a disposable companion index, and OpenClaw hooks/tools as the primary runtime surface.

## Relationship to Hermes `scope-recall`

ClawLore is the OpenClaw runtime implementation of the same storage philosophy used by the Hermes `scope-recall` plugin: SQLite truth first, rebuildable vector companion, hybrid retrieval, scoped recall, and conservative capture.

This package is not a one-for-one Hermes plugin copy and does not currently claim full Yuheng/Hermes 1.6.0 feature parity. It adopts the contracts that already have OpenClaw-native behavior, tests, and operator documentation, then tracks the remaining commercial-memory work in [`docs/commercial-memory-plugin-plan-2026-06-30.md`](docs/commercial-memory-plugin-plan-2026-06-30.md). OpenClaw-specific capabilities include:

- OpenClaw dynamic tools: `memory_recall`, `memory_store`, `memory_forget`, and `memory_update`.
- Optional operator and inspection tools when enabled: `memory_stats`, `memory_debug`, `memory_list`, `memory_context`, `memory_inspect`, `memory_promote`, `memory_archive`, `memory_compact`, and `memory_explain_rank`.
- OpenClaw-native governance review with `memory_govern`, including conflict-review rows, legacy/working scratch rows, inactive lifecycle rows, archived rows, and low-confidence capture candidates.
- Partial OpenClaw-native adoption of the Hermes 1.5/1.6 governance line: `scope_recall_governance_cleanup_*`, `scope_recall_memory_candidate_promotion_*`, `scope_recall_graph_hygiene_*`, `scope_recall_journal_recovery_*`, `scope_recall_digest_*`, and `scope_recall_operator_dashboard` provide dry-run-first cleanup, candidate promotion planning, graph-companion hygiene visibility, journal-recovery visibility, candidate-only digest distillation, and one-page operator health. The same surfaces are also available as `openclaw clawlore` operator CLI routes.
- Experience Kernel tools for task episodes, procedural playbooks, preflight packets, replay, forgetting reports, and review-gated promotion. The operator CLI can run replay fixtures against a playbook for release checks.
- Dry-run-first SQLite hygiene migration via `scripts/migrate-legacy-hygiene.mjs` for archiving legacy scratch rows and normalizing missing durable metadata without deleting content.
- OpenClaw primary command: `openclaw clawlore`; compatibility aliases:
  `openclaw scope-recall` and `openclaw memory-pro`.
- OpenClaw session hooks for auto-recall, auto-capture, session memory, memory reflection, and self-improvement reminders; these high-impact paths are opt-in and should be enabled only for deployments that want durable memory-to-prompt behavior.

Hermes-only V1 surfaces such as entity probe/related/feedback tools, full journal-first runtime capture, full Recall Funnel explain parity, richer fact-freshness doctor output, advanced relation extraction, and Hermes-specific shared-durable/local-scratch scope semantics remain separate roadmap items until they have OpenClaw-native UX, tests, and operator documentation. Conflict handling now follows the Hermes 1.0.13 posture: contradictions are flagged for operator review and linked with `contradicts` metadata instead of automatically superseding older memories.

`memory_context`, `memory_inspect`, and `memory_govern` are OpenClaw-native inspection tools, not direct Hermes name copies. They are read-only management tools for checking accessible memory context, single-record lifecycle metadata, relations, source/state/layer filters, governance candidates, and scope boundaries before changing recall behavior.

## Storage Model

`memory.sqlite3` is the truth store. The default vector companion is LanceDB. Set `vectorBackend: "sqlite-bruteforce"` to use the native-free SQLite vector companion on hosts where LanceDB, PyArrow, or CPU-native dependencies are unsafe. Both vector backends are rebuildable from SQL truth with:

```bash
openclaw clawlore repair-vectors --dry-run
openclaw clawlore repair-vectors --apply
```

Use `--limit <n>` for small test runs. Bare `repair-vectors` is a dry-run preview; `--dry-run` also wins over accidental `--apply`. When `--limit` is set, stale-vector pruning is disabled so partial repairs cannot delete unrelated vector rows.

Hosted embedding providers remain the recommended production path. If `embedding.provider` is `local-hash`, or if no hosted API key is configured, the plugin can generate deterministic local vectors with `hash-v1`. This keeps bootstrap, tests, and no-key availability working, but it is not a semantic-quality replacement for a real embedding model.

## Diagnostics

```bash
openclaw clawlore stats
openclaw clawlore stats --json
openclaw clawlore stats --json --quiet
openclaw clawlore doctor
openclaw clawlore doctor --json
openclaw clawlore doctor --json --quiet
openclaw clawlore repair-lifecycle-projection --json
openclaw clawlore repair-lifecycle-projection --apply --json
```

The stats command reports SQL truth availability, SQLite row count, FTS integrity, and whether the vector companion needs repair. The doctor command is read-only and adds scope distribution checks, SQL-vs-vector scope comparison, configured vector dimensions, missing/stale vector row counts, lifecycle-projection freshness, and repair hints. It reports projection drift without changing the database. `repair-lifecycle-projection` is also dry-run by default; only the explicit `--apply` form rebuilds the auxiliary projection from `memory_truth`. Use `--json --quiet` when automation needs JSON written directly to stdout through the OpenClaw CLI wrapper.

## Runtime isolation and release readiness

Keep `principalIsolation.enabled: true` and `principalIsolation.groupMemory:
"deny"` for public or mixed-membership groups. The optional
`legacyAgentScopePrincipals` list is an exact, temporary migration allowlist;
it should contain only canonical principals that are authorized to read the
pre-1.2 `agent:<id>` scope. Host channel policy should independently deny all
memory tools in groups so framework and plugin enforcement remain layered.

Shadow activation requires a private `0600` readiness receipt. The loader
binds that receipt to the exact Git commit, runtime artifact, package and lock
files, normalized plugin config, SQL truth snapshot, and test log. Receipts
expire and any mismatch fails closed. V2 write/cutover approval additionally
requires non-empty active lifecycle data and minimum real shadow sample,
overlap, rank, latency, forbidden-scope, and prompt-budget thresholds. A
zero-active or zero-parity dataset cannot produce a cutover-ready receipt.

## Operator CLI

The OpenClaw operator CLI includes the 1.0.26 partial adoption of Yuheng 1.6.0 maintenance concepts in OpenClaw-native terms:

```bash
openclaw clawlore dashboard
openclaw clawlore candidates report --json
openclaw clawlore candidates apply --dry-run
openclaw clawlore governance cleanup --dry-run
openclaw clawlore governance rollback --batch-id <id> --dry-run
openclaw clawlore governance audit-coverage --json
openclaw clawlore journal recovery --dry-run
openclaw clawlore graph hygiene --dry-run
openclaw clawlore digest report --json
openclaw clawlore digest run --principal-key <platform:account:principal> --dry-run --json
openclaw clawlore digest run --transcript-db /private/openclaw-agent.sqlite \
  --transcript-session-id <exact-session-id> \
  --principal-key <platform:account:principal> --dry-run --json
openclaw clawlore digest recovery --dry-run --json
openclaw clawlore forgetting report --json
openclaw clawlore forgetting run --dry-run
openclaw clawlore experience stats --json
openclaw clawlore experience promote --dry-run
openclaw clawlore experience replay --playbook-id <id> --json
openclaw clawlore playbooks list --json
openclaw clawlore playbooks review --id <id> --action review
openclaw clawlore playbooks promote --id <id>
openclaw clawlore playbooks quarantine --id <id>
openclaw clawlore playbooks supersede --id <id> --superseded-by <replacement-id>
```

Mutating maintenance routes remain explicit. `governance cleanup`, `journal recovery`, `graph hygiene`, `forgetting run`, and `experience promote` preview by default and require `--apply` to write. `candidates apply` and playbook lifecycle subcommands are explicit action routes; pass `--dry-run` to `candidates apply` when only a review is wanted.

SQLite transcript intake is exact-session and read-only. The database and any
existing WAL/SHM companions must be owner-only regular files, the target
principal or private session identity must be explicit, and a window with no
eligible user/assistant events fails instead of reporting a false-green run.
Tool arguments, tool-result bodies, thinking, custom events, and raw session
identifiers are not admitted. Transcript chunks remain raw evidence; only an
explicit `--apply` can create reviewable digest candidates.

## Legacy Compatibility

ClawLore was previously published as `scope-recall-openclaw` and, before that,
`memory-lancedb-pro`. OpenClaw may normalize the legacy plugin id to `clawlore`;
the old `openclaw scope-recall` and `openclaw memory-pro` commands remain aliases.
Existing databases remain authoritative: an explicit `dbPath` is preserved, and
the legacy data/OAuth locations are reused when no canonical ClawLore path exists.
The stable `scope_recall_*` tool ids are retained as wire contracts so automations
do not break during the product rename.

## Smoke Test

```bash
npm run smoke:vector-repair
node scripts/golden-benchmark.mjs
npm run benchmark:production -- --summary
npm run release:prepush
```

The smoke test creates a temporary database, writes two SQL-truth memories, dry-runs vector repair, rebuilds the vector companion with a fake embedder through the explicit apply path, verifies diagnostics, and deletes the temp database.

The golden benchmark keeps a small SQLite truth/FTS compatibility smoke. The
production benchmark replays the same annotated corpus through the real
`MemoryStore` and hybrid `MemoryRetriever` with deterministic offline vectors,
and reports Recall@K, Precision@K, MRR, nDCG@K, bad recall, scope leakage,
prompt budget, latency, and exercised retrieval stages.

The non-authorizing pre-push gate checks package/manifest version consistency, changelog
coverage, schema/UI config exposure, compiled output, vector repair, both recall
benchmarks, Experience replay fixtures, and public npm pack contents. The default
`npm run release:gate` additionally requires an exact live `extensions/clawlore`
artifact and canonical OpenClaw inspect/doctor smoke; it must fail before audited
deployment. The pack scan rejects runtime or sensitive artifacts such as databases,
logs, backups, `node_modules`, temporary/archive directories, and credential-shaped
paths.

`npm run release:prepush` requires a clean commit and canonical repository
identity but deliberately does not claim that commit is already published. It
does not accept or rewrite canonical release evidence. After pushing, run
`npm run release:gate:source` against the exact remote branch or tag; that strict
gate proves publication and checks the canonical evidence before any live gate.

The gate also proves that local `HEAD` is published at the exact target remote
ref (default `refs/heads/main`). Use `--release-ref refs/tags/<tag>` when a tag
is the release truth. For an exact legacy principal allowlist, pass the trusted
adapter-derived canonical key explicitly:

```bash
npm run release:gate -- \
  --principal 'telegram:default:<numeric-user-id>' \
  --release-ref refs/heads/main
```

The equivalent automation inputs are `CLAWLORE_RUNTIME_PRINCIPAL` and
`CLAWLORE_RELEASE_REF`; display names, wildcards, and group identifiers are not
valid substitutes for a direct user's canonical principal.

After all gates pass on a clean commit, `npm run release:readiness` can create
the immutable build-provenance sidecar and expiring shadow receipt. The command
requires explicit paths for the full test log, OpenClaw config, SQL truth DB,
and receipt output; it does not authorize V2 writes or cutover.

## Public Release Staging

This plugin is usually developed inside a larger OpenClaw state directory. Do not publish from that root. Stage a clean release tree containing only public plugin files, then scan the staged tree before creating tags or pushing to GitHub.

## License

MIT
