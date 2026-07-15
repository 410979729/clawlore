# Changelog

## 1.2.0

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

## Unreleased

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
