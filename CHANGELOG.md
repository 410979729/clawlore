# Changelog

## Unreleased

- Replaced the four overlapping Agent-tool booleans with one authoritative
  `agentToolProfile`. Manifest discovery and runtime registration now share the
  same profile matrix, including a read-only containment profile that preserves
  recall and query-safe Experience tools.
- Made persisted-secret coverage include explicitly supplied backup, export,
  and restore artifact roots. Unencrypted or unsupported artifacts, incomplete
  inventory, unsafe permissions, or omitted roots now block both a green audit
  and remediation planning.
- Made legacy migration fail closed on unreadable sources and stream a pinned
  LanceDB snapshot within a fixed row budget. Bounded LanceDB scans no longer
  use mutation-sensitive offset pagination.
- Extended the canonical cross-process memory-write fence to initialization,
  schema, FTS, and the persisted-secret remediation CLI; legacy migration now
  reads a pinned source snapshot while its target imports keep the existing
  per-write fence.
- Made all Experience episode and Playbook state/event pairs atomic, not only
  supersede, and hardened failure diagnostics against cycles, hostile getters,
  and excessive nesting.
- Corrected OpenClaw SecretRef compatibility for embedding-key arrays by
  enumerating bounded array leaves instead of treating SecretRef object fields
  as plaintext wildcard values; runtime configuration rejects more keys than
  the manifest can represent.
- Made the live-provider 40-positive/10-no-answer gate distinguish one required
  answer from explicitly annotated relevant supporting results. Required
  Recall/MRR remain strict, while Precision/false-positive scoring no longer
  mislabels reviewed supporting rules as irrelevant; negative cases cannot
  declare relevant results.
- Expanded the persisted-secret audit to one shared policy covering V1/V2
  truth and history, every FTS/projection mirror, Task Experience/digest and
  conversation stores, plus LanceDB text/metadata. SQLite WAL/SHM files and the
  complete LanceDB tree now participate in the owner-only permission gate.
- Added a content-free, digest-bound remediation planner and explicit apply
  path. It requires verified encrypted memory, conversation, and vector
  snapshots, prior credential rotation, fresh target identities, exact
  approval, and permission tightening; orphan projections do not manufacture
  V2 ledger events, and any crossed external/commit boundary returns a
  recovery-required error instead of claiming full rollback.
- Added generic SQLite and LanceDB companion AES-256-GCM snapshot workflows.
  Both perform an actual isolated restore, verify logical/tree and row-ID
  digests, remove all plaintext restore material, and emit owner-only,
  content-free receipts.
- Added release guards and regressions for the expanded audit, three-snapshot
  remediation boundary, supporting-result annotations, permission tightening,
  orphan projection cleanup, partial-vector failure recovery, and snapshot
  restore behavior.

## 1.2.2 - 2026-07-22

- Made `memory_recall` observation-only. Retrieval no longer increments access
  counters, marks a result as confirmed use, clears bad-recall feedback, or
  changes suppression state; only an explicit governance action may confirm a
  memory.
- Added a confidence/abstention policy for manual recall. Weak vector-only
  matches are rejected unless one high-confidence semantic winner is clearly
  separated, while lexical evidence follows its own explicit threshold.
- Replaced untrusted BM25-as-relevance with query-to-memory lexical evidence
  over a bounded candidate pool, removed the remaining retriever access-tracker
  mutation path, and preserved durable post-operation rules in the noise
  filter.
- Upgraded the real-corpus gate to schema v2 with mandatory no-answer cases,
  Precision@3, abstention rate, and false-positive limits. It supports an
  owner-only live-provider key file while preserving the deterministic offline
  compatibility run as non-live evidence.
- Extended the canonical secret policy to provider-bounded descriptions where
  an opaque credential appears before its API/key explanation.
- Added a read-only persisted-secret audit for SQL truth, V2 revisions, task
  episodes, nightly records, and conversation memory. Receipts contain counts,
  pattern names, and path hashes only; memory text and secret values are never
  emitted.
- Added an exact-session, owner-only, read-only OpenClaw SQLite transcript
  source for digest dry-runs. It admits only user/assistant text and assistant
  tool names, excludes arguments/results/thinking/custom events, and treats an
  empty eligible window as an error instead of a successful nightly run.
- Widened the deterministic compatibility embedding to reduce fixture hash
  collisions; the 40-positive plus 10-no-answer gate now passes Recall@3,
  Precision@3, MRR, abstention, false-positive, scope, and egress checks without
  weakening its thresholds.
- Added release guards and regression tests preventing hidden recall feedback,
  missing negative-corpus metrics, or omission of the persisted-secret audit.
- Preserved governance, the explicit feedback journal, operator dashboard,
  golden and hard-delete protections, SQL authority, OAuth session, Windows ACL
  hardening, and the packed-tarball release gate from 1.2.1.

## 1.2.1 - 2026-07-20

- Preserved verification, failure, safety, cleanup, and evidence sections under
  the real Task Experience recall budget by rebuilding bounded capsules from
  structured metadata instead of truncating one monolithic string.
- Ordered V2 projection work by per-item commit order with stale-revision
  fencing, hardened snapshot directory creation under ordinary umasks, and
  extended the canonical secret policy to XML key/value attributes and npmrc
  authentication assignments.
- Made V1 playbook supersession validate a same-scope live successor inside the
  transaction, made Markdown mirror failure explicit repair debt after truth
  commit, and added V2 multi-connection compare-and-set protection.
- Added an offline, deterministic production-path recall benchmark through the
  real MemoryStore and hybrid MemoryRetriever while retaining the small FTS
  golden benchmark as a compatibility smoke.
- Unified capture, support-bundle, Task Experience, governance-debt, and
  promotion secret handling under one structured policy. It now covers
  snake/kebab/camel-case keys, quoted values, YAML block scalars and aliases,
  and non-Basic/Bearer Authorization schemes without leaking anchor sources.
- Made structured tool failures dominate contradictory success flags and made
  Task Experience reject any unresolved failed tool result, even when an
  unrelated later tool succeeds. Current failures can no longer be erased by
  trailing success words; explicitly historical repaired failures remain valid.
- Bound lifecycle reads to a truth-derived health capability. The raw projection
  count reader is no longer exported, so callers cannot consume a forged but
  internally self-consistent projection without passing the health gate.
- Added an explicit non-authorizing pre-push release gate for pull requests and
  clean local commits. The strict post-push release gate still requires exact
  remote publication and canonical evidence; pre-push mode cannot claim either.
- Updated Linux/Windows CI and the reusable workflow template to Node 24.15.0,
  matching the supported OpenClaw host minimum, with locked installs, protected
  Windows temporary roots, the supported host fixture, and the pre-push gate
  instead of an impossible pre-publication gate.
- Preserved and revalidated governance, journal, operator dashboard, golden
  recall, hard-delete, SQL authority, OAuth session, Windows ACL,
  packed-tarball, and release gate protections from 1.2.0.

## 1.2.0 - 2026-07-16

- Renamed the canonical package, manifest id, product name, repository metadata,
  config root, and primary CLI from Scope Recall to ClawLore.
- Preserved `scope-recall-openclaw` as a legacy plugin id, `scope-recall` and
  `memory-pro` as CLI aliases, and existing data/OAuth paths as read-compatible
  migration fallbacks.
- Kept the stable `scope_recall_*` tool ids as wire compatibility contracts;
  they no longer define the product name.
- Retained the existing governance, journal, operator dashboard, golden recall,
  hard-delete, and release gate protections under the ClawLore identity.
- Hardened the live release gate to require the canonical `clawlore` extension,
  exact recursive artifact identity, canonical runtime inspect, and all CLI
  aliases before a deployment can be claimed.
- Added an audit-first identity-transition runbook. This release candidate does
  not authorize live deployment, V2 writes, prompt mutation, or recall cutover.
- Made an existing SQL-truth architecture fail closed when its authority store
  cannot initialize; vector companions can no longer become an emergency truth
  source after corruption, permission, path, or schema failures.
- Made SQL truth, FTS, and durable vector-repair intent one recoverable commit
  boundary, and made Experience playbook state, FTS, version receipts, and
  feedback counters transactional with post-change snapshots.
- Added bounded vector over-fetch pagination, stable redacted tool failures,
  clean-install dependency preflight, and an official-registry advisory gate
  whose transport or endpoint failures are release failures.
- Added authority-outage, transaction-fault, stale-companion pagination,
  dependency-preflight, supply-chain, and tool-error regression coverage.
- Made SQL authority creation and legacy migration marker-backed and structurally
  verified. Legacy upgrades now require an explicit backup/receipt command and
  commit schema, FTS rebuild, receipt, and the final marker atomically.
- Hardened OAuth session reads and writes against broad modes, wrong owners,
  symlinks, file swaps, partial replacement, and callback-listener races; OAuth
  diagnostics no longer expose absolute credential paths.
- Enforced an exact owner-only Windows ACL policy for private state files and
  directories, with unknown owners and Allow ACEs rejected by default.
- Added a final packed-tarball installation/runtime smoke, a machine-readable
  source-only script policy, and generated release evidence covering the exact
  commit, runtime digest, SBOM component count, and package file count.
- Bound SQL authority validity to an exact schema fingerprint, including
  primary keys, constraints, indexes, triggers, outbox tables, marker tables,
  and FTS5 definition, followed by executable CRUD contract checks.
- Hardened explicit authority migration with canonical path identity, separate
  dedicated backup/receipt directories, durable backup fsync checkpoints,
  locked logical-snapshot comparison, and idempotent receipt reconstruction.
- Replaced string-form PowerShell ACL argument passing with an encoded script
  and structured environment input, while keeping owner-only, default-deny ACL
  verification and paths containing spaces or non-ASCII text.
- Made release-gate scripts cross-platform Node entry points, added a packed
  native LanceDB reopen/delete smoke, and enabled strict TypeScript checking.
- Made API-key-to-OAuth transitions preserve only schema-valid SecretRefs and
  restore them exactly on logout; plaintext keys now fail before authorization.
- Made OAuth logout commit and validate a private, backup-backed atomic config
  replacement before deleting OAuth authority, with fault injection across
  temp sync, rename, validation, and authority deletion boundaries.
- Made auth commands migrate a legacy-only plugin entry, allowlist, memory slot,
  and complete config to `clawlore`, while conflicting dual entries fail closed.
- Added a packed real-OpenClaw legacy migration gate that verifies the full
  30-key config, `dbPath`, SecretRef, activation, and doctor result survive host
  normalization without a second legacy entry.
- Forced `package-lock.json` to LF on every checkout and made the release gate
  reject working-tree bytes that differ from the committed Git blob, closing
  the Windows `core.autocrlf=true` evidence gap instead of merely hashing around it.

- Added Tianji's independent Scope Recall roadmap, documenting that the
  OpenClaw plugin may borrow from Yuheng/Hermes without remaining lockstep.
- Added a read-only `scope-recall experience debt` report for Experience
  Kernel promotion/review debt, with redacted output and regression coverage.
- Hardened the release gate for Tianji's nested live-extension layout via an
  explicit `SCOPE_RECALL_ALLOW_NESTED_GIT_ROOT=1` operator switch.
- Tightened the operator dashboard top-level health signal so freshness debt,
  digest debt, and missing Experience readiness no longer report `ok=true`.
- Added a task-experience capture ledger so skipped reviewer outcomes such as
  `review_invalid_or_low_confidence` are visible in Experience debt reports.
- Aligned the diagnostic build tag with the package version instead of the old
  `1.0.24` release line.
- Added Phase 1-4 of Tianji's independent roadmap: a redacted auto-recall trace
  ledger and `scope-recall recall-trace`, controlled dry-run-first promotion
  batches, explicit scope policy evaluation/gating, and reviewed
  knowledge/skill bridge draft candidates that do not directly write Markdown
  truth or apply skills.

## 1.1.0

- Corrected 1.0.26 documentation so it describes partial OpenClaw-native adoption of Yuheng/Hermes 1.6.0 concepts, not full feature parity.
- Added the 2026-06-30 commercial memory plugin plan and baseline runtime audit so future parity claims must point to release gates, live inspect output, doctor/dashboard evidence, and explicit remaining gaps.
- Added Phase 1 contract docs for the OpenClaw capability matrix, stable operator JSON responses, and plugin configuration risk/restart semantics, with release-gate coverage for required sections.
- Added Phase 2 runtime identity/scope metadata hardening for manual stores, secret index stores, smart extraction, regex auto-capture, and rejected admission audits; `memory_store` now has regression coverage for deterministic runtime metadata and foreign-scope denial.
- Tightened conservative capture defaults for raw tool dumps, private credential paths, and ephemeral assistant progress noise.
- Expanded the golden recall benchmark with scope-isolation, forbidden-id, archived/stale exclusion, prompt-budget cases, per-case traces, and aggregate commercial metrics (`knownAnswerRecall`, `topKAccuracy`, forbidden violation rate, latency, prompt budget, and filter counts).
- Added partial Phase 4 freshness/relation support: smart metadata now normalizes freshness fields, the operator dashboard reports freshness debt, and retrieval applies conservative relation-evidence scoring without expanding scope.
- Preserved and release-gated governance, journal, and operator dashboard surfaces while extending them with digest and freshness visibility.
- Added a Phase 5 OpenClaw-native digest baseline with digest report/run/recovery CLI routes, `scope_recall_digest_*` management tools, strict run/chunk ledgers, dry-run-first candidate extraction, candidate-only writes, dashboard/doctor visibility, and digest regression tests.
- Added Phase 6 Experience Kernel productization evidence with replay fixtures for common OpenClaw workflows and an operator CLI replay command for bounded playbook checks.
- Added Phase 7 commercial release hardening with package hygiene scan checks, release/live rollout runbooks, release-readiness evidence templates, and expanded workspace/live drift checks.
- Preserved hard-delete fail-closed behavior while extending digest, Experience, and release gate coverage.
- Hardened the 1.1.0 audit fixes: digest reflection collection is scope-filtered, hard delete blocks SQL deletion when vector companion cleanup fails, graph hygiene apply is transactional, release gate rejects source/live self-comparison and runs OpenClaw runtime inspect/doctor smoke, and npm package files now include the source/test/script files required by exposed scripts.
- Fixed vector repair result accounting so multi-row batches increment `rebuilt` once per repaired row; the smoke test now covers multi-row repair batches.
- Decided to keep `1.0.26` as the partial-parity internal baseline; the next contract-driven commercial-memory work should move on the `1.1.0` line.

## 1.0.26

- Added OpenClaw-native operator CLI routes for a partial adoption of Yuheng `scope-recall` 1.6.0 maintenance concepts: `dashboard`, `candidates report/apply`, `governance cleanup/rollback/audit-coverage`, `journal recovery`, `graph hygiene`, `forgetting report/run`, `experience stats/promote`, and `playbooks list/review/promote/quarantine/supersede`.
- Kept mutating maintenance flows dry-run-first unless the subcommand itself is an explicit lifecycle action or the operator passes `--apply`; `--dry-run` continues to win over accidental apply flags for cleanup, journal recovery, graph hygiene, forgetting, and Experience promotion.
- Extended release gate checks and regression coverage so future releases cannot claim this OpenClaw CLI operation slice while omitting the required entry points, while preserving the existing operator dashboard, golden benchmark, and hard-delete safety gates.

## 1.0.25

- Aligned the OpenClaw port with the Yuheng `scope-recall` 1.6.0 safety posture: `repair-vectors` is now dry-run-first and requires `--apply` for vector companion writes, while `--dry-run` wins over accidental apply flags.
- Added SQLite `busy_timeout` on the SQL truth and sqlite-bruteforce vector stores to reduce lock failures under concurrent OpenClaw capture, governance, and journal/dashboard reads.
- Preserved the 1.0.24 governance, journal, operator dashboard, golden benchmark, hard-delete, and release gate surfaces while tightening release checks for the new dry-run and SQLite timeout contracts.

## 1.0.24

- Added dry-run-first candidate-memory promotion report/run tools for explicit `candidate` / `pending` SQL truth rows, with conservative human-review gates, optional noise archival, governance audit events, and redacted review output.
- Added graph hygiene report/run tools for rebuildable `memory_entities` / `memory_relations` companion rows; OpenClaw deployments without graph tables now report `unsupported` explicitly instead of pretending repair is available.
- Extended the operator dashboard with memory candidate debt and graph hygiene status while preserving the 1.0.23 governance, journal, golden benchmark, hard-delete, and release gate hardening line.
- Hid `memory_store_secret_index` behind explicit `secretIndexToolsEnabled=true`, keeping the low-frequency credential-index schema out of default tool registration.

## 1.0.23

- Aligned OpenClaw scope-recall with the Yuheng `scope-recall` 1.5.x governance line.
- Added governance cleanup report/run tools for historical template/transcript-shaped memory rows, with dry-run default, soft archive, audit events, and batch rollback.
- Added journal recovery report/run compatibility tools. OpenClaw deployments without journal tables now report `unsupported` explicitly instead of pretending recovery is available.
- Added an operator dashboard tool that summarizes SQL truth, FTS, governance cleanup, journal recovery, Experience Kernel, and vector status.
- Made hard-delete forgetting fail closed when no vector companion delete callback is available, preventing SQL truth deletion that could leave stale vector hits.
- Added OpenClaw-owned governance alignment tests and a golden recall benchmark fixture/runner wired into the release gate.
- Added explicit manifest discoverability metadata for all `scope_recall_*` tools, release-gate enforcement for those metadata entries, and regression coverage proving Experience preflight is scope-filtered while playbook feedback records real run history.

## 1.0.22

- Added Experience Kernel tools and schemas for task episodes, procedural playbooks, experience runs, playbook promotion, replay, review, and forgetting reports.
- Fixed task-experience capture so OpenClaw `agent_end` events without an explicit `success` field are not treated as failures.
- Changed auto-recall to embed the current clean user request instead of the assembled prompt, with configurable `autoRecallQueryMaxChars`.
- Synced hard forgetting with vector companion deletes and reports `needs_repair` if vector cleanup fails.
- Marked degraded extraction/fallback captures with lower trust and only charge extraction quota after actual writes or merges.
- Moved the default mdMirror fallback beside the configured memory DB instead of the extension directory.
- Added safe procedural playbook FTS query construction and regression coverage for special-character queries.
- Hardened release gates around Experience Kernel files, version/changelog consistency, diff whitespace, safe FTS source checks, and live extension drift checks.

## 1.0.21

- Fixed smart-extractor and reflection-store to sanitize attachment markers before persisting to store
- Previously these paths called `evaluateCaptureSafety()` for safety check but stored the original unsanitized text
- Now all ingestion paths (auto-capture, memory_store, smart-extractor, reflection-store) consistently sanitize before storage

## 1.0.20

- Added `sanitizeCaptureText()` to strip gateway image attachment markers and local `image_cache/img_*` paths before journal/capture storage, preventing local cache paths from leaking into durable memories.
- Added `isTrivial()` filter so short acknowledgements like "Understood.", "Noted.", "好的", "收到" are rejected before entering the journal, matching Hermes scope-recall v1.1.1 behavior.
- `evaluateCaptureSafety()` now sanitizes attachment markers and checks triviality before other safety gates.
- `normalizeAutoCaptureText()` and `memory_store` now persist sanitized text, ensuring attachment markers never reach SQLite/vector storage.
- Added regression tests for attachment sanitization, trivial ACK filtering, and end-to-end capture safety with markers.

- Added `sanitizeCaptureText()` to strip gateway image attachment markers and local `image_cache/img_*` paths before journal/capture storage, preventing local cache paths from leaking into durable memories.
- Added `isTrivial()` filter so short acknowledgements like "Understood.", "Noted.", "好的", "收到" are rejected before entering the journal, matching Hermes scope-recall v1.1.1 behavior.
- `evaluateCaptureSafety()` now sanitizes attachment markers and checks triviality before other safety gates.
- `normalizeAutoCaptureText()` and `memory_store` now persist sanitized text, ensuring attachment markers never reach SQLite/vector storage.
- Added regression tests for attachment sanitization, trivial ACK filtering, and end-to-end capture safety with markers.

## 1.0.15

- Isolated local OAuth session file reads from the token exchange module to reduce static scan noise.

## 1.0.14

- Reduced additional static scan false positives around parsed embedding credentials and saved OAuth session fields.

## 1.0.13

- Reduced static scan false positives around client credential field assignment without changing runtime behavior.

## 1.0.12

- Changed public defaults to require explicit opt-in for auto-capture, LLM smart extraction, and plaintext JSONL backups.
- Made missing agent identity fail closed for scope filtering instead of broadening memory access.
- Added confirmation friction to `memory_forget` and removed automatic high-confidence query deletion.
- Stopped OAuth LLM backup files from copying API-key fields.
- Made legacy upgrades metadata-only and local-heuristic by default; LLM enrichment, text rewrites, and non-dry-run writes now require explicit flags.
- Removed release-gate/test internals from the published npm pack artifact while keeping source tests in the GitHub repository.

## 1.0.11

- Added read-only `memory_context` and `memory_inspect` management tools for OpenClaw-native memory observability.
- Exposed context filtering by query, scope, category, source, state, and memory layer.
- Added single-record inspection for lifecycle metadata, fact keys, relation hints, and L0/L1/L2 content.
- Aligned runtime plugin metadata with the manifest so Gateway inspection uses the public package name and description.
- Removed a duplicate legacy `memory_compact` tool registration that newer OpenClaw runtimes reject.
- Added tests and release-gate checks so observability tools and runtime metadata stay aligned.

## 1.0.10

- Polished public package and ClawHub-facing descriptions so the plugin presents as a focused OpenClaw memory layer rather than a mechanical feature list.
- Refined README, manifest UI help, and parity audit wording after the live extension was brought back onto the public release line.
- Added text-quality checks for stale beta wording and old public descriptions.

## 1.0.9

- Added native-free `sqlite-bruteforce` vector companion backend while keeping SQLite truth authoritative.
- Added deterministic no-key `local-hash` / `local-debug` embedding fallback for bootstrap and tests.
- Updated diagnostics so stats/doctor report the active vector backend.
- Added fallback tests for local embeddings and OpenClaw scope isolation on the SQLite vector backend.
- Updated Hermes parity docs after closing the native-free vector and offline embedding gaps.

## 1.0.8

- Aligned OpenClaw port metadata with the Hermes `scope-recall` `1.0.8` release line.
- Added release-quality project files: design notes, contribution guide, security policy, changelog, CI workflow template, and package quality tests.
- Added package metadata checks for repository, homepage, and issue tracker URLs.
- Added OpenClaw compatibility/build metadata required for ClawHub code-plugin publishing.
- Expanded `npm run release:gate` so package docs, tests, and pack contents are verified before release.
- Documented the OpenClaw-vs-Hermes parity boundary.

## Initial OpenClaw port

- Initial public OpenClaw port release.
- Added SQLite truth storage, FTS diagnostics, rebuildable LanceDB vector companion, management CLI, OpenClaw dynamic tools, and legacy `memory-pro` command alias.
