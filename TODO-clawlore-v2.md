# ClawLore 2.0 TODO

Updated: 2026-07-12

## Phase 0

- [x] Import Tianji live 1.1.0 into an isolated local Git baseline.
- [x] Record RFC, migration plan, and ADR-001 through ADR-009.
- [x] Implement Memory Address V2 types and validation.
- [x] Implement Identity Resolver and policy decision pure functions.
- [x] Implement read-only legacy address mapping preview.
- [x] Add fixtures, tests, and JSON smoke command.
- [x] Run typecheck, focused tests, full tests, build, and smoke.
- [x] Write the run report and update workspace project/day handoff.

## Phase 1A — ContextPack shadow spine

- [x] Define the ContextPack V1 schema and one compatibility Context Composer.
- [x] Add runtime `senderId` evidence to a shadow adapter without changing recall.
- [x] Fail closed before retrieval when identity/policy preflight is unresolved.
- [x] Apply lifecycle, verification, reviewed-playbook, policy, and one token budget.
- [x] Add fixtures, focused tests, JSON smoke, and a dated run report.
- [x] Run typecheck, full regression, build, old/new smokes, golden recall, and release gate.

## Phase 1B — Legacy source shadow comparison

- [x] Adapt the three current prompt producers into read-only composer sources.
- [x] Add deterministic legacy-vs-ContextPack shadow comparison fixtures/traces.
- [x] Preserve legacy identity debt and reject ambiguous private rows.
- [x] Demote reflection rules to untrusted data and require reviewed playbooks.
- [x] Add six focused tests and a machine-readable JSON smoke.
- [x] Run full regression, typecheck, build, old/new smokes, golden recall, and release gate.

## Phase 1C — 1.x safety hardening

- [x] Declare plugin SecretRef contracts without copying credential values.
- [x] Disable plaintext JSONL auto-backup and destructive startup compaction.
- [x] Hide management tools behind explicit operator gates.
- [x] Keep only read-only playbook search/inspect/preflight discoverable by default.

## Phase 2A — Truth/runtime spine

- [x] Add a default-off, redacted runtime shadow trace without replacing hooks.
- [x] Add revision/source/ACL/event/outbox Truth V2 transactions.
- [x] Add read-only legacy migration preview with verification debt.
- [x] Add one unified distillation admission path and retryable projection worker.
- [x] Add four-action Agent facade over the shared Truth V2 service.
- [x] Filter private/conversation/project access in SQL before returning rows.
- [x] Deny ungranted team/global rows and expired rows by default.
- [x] Add compatibility-first ContextEngine capability negotiation skeleton.
- [x] Align the release gate with the reduced Experience discoverability contract.

## Next slice candidates

- [x] Add online SQLite snapshot backup, restore-to-new-location verification, and rollback drill.
- [x] Add additive v2 migration apply/rollback against copied fixtures; never the live database.
- [x] Adapt legacy auto-capture/reflection/digest/task-experience triggers to one candidate journal.
- [x] Add correction/forget projection convergence receipts and operator inspection.
- [x] Add encrypted archive wrapping and key-provider integration around verified snapshots.

## Phase 2B — Module boundaries and verified snapshot

- [x] Introduce a `TruthStoreV2Port`; application services no longer import the
      concrete SQLite adapter.
- [x] Define module ownership and preserve SQL/FTS/vector/relations/Experience
      as separate capabilities.
- [x] Add an executable module-boundary test.
- [x] Repair the existing OpenClaw adapter -> migration reverse dependency.
- [x] Create online SQLite snapshots while the source store remains open.
- [x] Verify checksum, schema, integrity, foreign keys, and truth-table counts.
- [x] Restore only to a new location and remove failed restore destinations.
- [x] Reject tampered snapshots before restore.

## Phase 2C — Legacy migration drill

- [x] Require a read-only migration plan and stable digest before apply.
- [x] Require explicit approval and a destination that does not exist.
- [x] Preserve manual/user-confirmed rows as active only when identity resolves.
- [x] Preserve ambiguous/auto-extracted rows as unverified candidates.
- [x] Preserve archived/rejected/superseded legacy rows as non-active.
- [x] Record legacy classification, scope, identity review, and verification debt
      as source evidence.
- [x] Write a 0600 migration marker and require its id/digest for rollback.
- [x] Prove the legacy SQLite hash is unchanged before/after preview, apply, and rollback.

## Phase 2D — Encrypted snapshot archive

- [x] Wrap verified online snapshots with AES-256-GCM.
- [x] Resolve archive keys through a file SecretRef-style provider.
- [x] Reject group/other-readable key files and write archives as 0600.
- [x] Verify outer archive checksum and inner SQLite integrity before restore.
- [x] Restore only to a new location.
- [x] Remove plaintext SQLite, WAL, and SHM temporary files on all paths.

## Phase 2E — Projection convergence receipts

- [x] Return typed FTS/vector/relations projection handles from mutations.
- [x] Inspect exact outbox rows without exposing memory content.
- [x] Distinguish pending, retrying, processed, and missing states.
- [x] Claim convergence only when all expected projections are processed.
- [x] Prove correction retry and forget deletion convergence in fixtures.

## Phase 3A — Unified legacy trigger journal

- [x] Adapt auto-capture, reflection, digest, and task experience to one event contract.
- [x] Generate deterministic ids and preserve explicit provenance ids.
- [x] Prevent trigger adapters from writing any store directly.
- [x] Route all automatic events through one journal, admission, and outbox path.
- [x] Keep all automatic outputs candidate-only, including tool-verified episodes.

## Phase 4A — Read-only Memory Center model

- [x] Add a read-only application model over Truth V2 instead of a second UI store.
- [x] Expose ACL-filtered knowledge, used-this-turn, provenance, review inbox,
      corrections, current conflicts/stale facts, scope counts, projection health,
      provider egress declarations, and product capabilities.
- [x] Reuse the storage ACL predicate for memories, events, relations, and outbox health.
- [x] Reject ContextPacks whose actor differs from the Memory Center actor.
- [x] Suppress inaccessible ContextPack items and historical-revision conflicts.
- [x] Keep backup/export/playbook operations descriptive and read-only in this slice.

## Phase 5A — Subagent and Experience lifecycle

- [x] Add separate domain, application port/service, SQLite adapter, and OpenClaw adapter modules.
- [x] Implement isolated snapshots with explicitly authorized non-private context only.
- [x] Implement fork snapshots as read-only copies of the bounded parent ContextPack.
- [x] Deny child durable writes; keep safe scratch candidate-only and ephemeral/working.
- [x] Atomically revoke a snapshot while creating the child episode candidate.
- [x] Require parent ownership, successful outcome, receipts, and evidence for parent verification.
- [x] Require parent/actor ownership before episodes can seed a playbook candidate.
- [x] Prevent single-run promotion unless a separate operator review is explicit.
- [x] Add promoted/quarantined/superseded playbook lineage and negative-feedback quarantine.
- [x] Add replay quality gates for scope, tools, prerequisites, steps, verification, and disabled steps.

## Phase 6A — Compatibility and release readiness

- [x] Freeze package, manifest, config root, CLI aliases, data path, and source metadata compatibility.
- [x] Define stable release-readiness and rollout-preview response schemas.
- [x] Require mode-specific evidence for shadow, V2 write, and cutover previews.
- [x] Keep every non-disabled rollout subject to separate operator approval.
- [x] Make shadow read-only and require snapshot/migration/rollback/hash gates before writes or cutover.
- [x] Add recursively redacted support-bundle output for credentials, authorization, private keys, and local paths.

## Phase 6B — Default-off runtime composition

- [x] Add an isolated `clawloreV2` schema request with `disabled` as the default.
- [x] Require a matching release-readiness receipt and separate operator approval before shadow registration.
- [x] Register exactly one low-priority `before_prompt_build` observer in approved fixture shadow mode.
- [x] Keep Agent tools, writes, prompt mutation, and ContextEngine registration at zero.
- [x] Hash runtime trace ids and retain only the existing redacted shadow receipt.
- [x] Fail open on retrieval timeout or trace-sink failure so memory observation cannot block ordinary replies.
- [x] Reject native ContextEngine activation even when the fixture host advertises all capabilities.
- [x] Add five focused tests and a machine-readable fixture-host smoke.

## Phase 6C — Live read-only shadow acceptance

- [x] Integrate the approved composition root into the live plugin without
      enabling V2 writes, prompt mutation, or ContextEngine.
- [x] Replace the plugin-bound-only `inbound_claim` observer with the generic
      `message_received` ingress and preserve direct/group scope boundaries.
- [x] Deploy matching source/dist artifacts and verify their hashes against the
      isolated release candidate.
- [x] Verify the live Gateway, health endpoint, runtime registration receipt,
      redacted trace permissions, and zero V2 tables.
- [x] Prove one real Joy Telegram direct message passes identity and policy and
      invokes retrieval without injecting or writing anything.
- [x] Re-run the 149-test suite, typecheck, build, runtime/module/vector smokes,
      golden recall, and release gate.

## Phase 6D — Read-only observation window

- [x] Add a zero-write JSONL observation auditor that enforces private file
      permissions, rejects unexpected/raw-payload fields, and reports redacted
      identity/policy/retrieval/candidate aggregates.
- [x] Collect additional real direct-message shadow traces and verify stable
      identity/policy decisions, bounded candidate counts, and fail-open replies.
- [x] Exercise one authorized group-message boundary and prove it cannot acquire
      private-principal visibility.
- [x] Add a redacted observation summary and explicit go/no-go receipt for the
      separately approved V2-write phase.

## Phase 7 — Separately approved V2 write migration

- [x] Create and verify a live encrypted snapshot before any schema change.
- [x] Run the migration preview against a verified copy and adjudicate identity
      and scope debt before apply.
- [x] Create a fresh evidence-bound V2-write readiness receipt that cannot
      authorize writes by itself.
- [x] Obtain separate operator approval for rollout
      `clawlore-v2-write-20260712-r1`.
- [x] Apply additive V2 schema/writes with V1 fallback, then verify SQL/FTS/vector/
      relation/Experience projection convergence and rollback evidence.
- [x] Keep ContextEngine and final recall cutover disabled until a later gate.

## Phase 7A — Read-only live migration preflight

- [x] Add WAL-consistent legacy 1.x online snapshot inspection and verified
      restore-to-new-location without requiring Truth V2 tables.
- [x] Add AES-256-GCM legacy snapshot archive support with a 0600 file
      SecretRef and plaintext/WAL/SHM cleanup on all paths.
- [x] Run migration planning only against a temporary verified copy and prove
      live logical truth stayed stable during the preview.
- [x] Emit a 0600 redacted receipt that explicitly denies V2-write authority.
- [x] Split 951 live rows into source and attribution-debt review lanes.
- [x] Add registry-bound session attribution preview without reading transcript
      content; exact live coverage is 77 direct-principal rows plus 15
      conversation-boundary rows.
- [x] Adjudicate the current 383-row broad session-reference lane from registry
      metadata only: 93 trusted, 114 system-derived, 78 legacy agent aliases,
      98 opaque/quarantined, and zero unresolved session keys or conflicts.
- [x] Review the 77 manual rows without reading content for identity: preserve
      1 archived row and require operator assignment for 76; activate none.
- [x] Add a collision-safe encrypted live-snapshot executor that rejects
      existing destinations, restore-tests to a disposable path, removes all
      plaintext SQLite files, and emits a 0600 non-authorizing receipt.
- [x] Select an approved persistent SecretRef and run the executor against the
      actual live source before requesting V2-write approval.

## Phase 7B verification

- Live read-only preflight: 952 rows stable during the run; active 0, candidate
  632, archived 320; `authorizesV2Writes=false`.
- Refined session attribution: trusted private 78, conversation 15, unresolved
  session references 0, conflicting evidence 0, transcript content read false.
- Manual review: 77 total; operator identity assignment 76, archived 1,
  automatic activation 0, content read false.
- Focused attribution/encrypted workflow tests: 8/8 PASS.
- Full plugin tests: 162/162 PASS.
- Typecheck/build/module boundaries/vector repair/golden recall/release gate:
  PASS; package scan 348 files.
- Implementation commit: `3692f99`.
- Live V2 schema/writes, configuration, prompt mutation, ContextEngine, and
  Gateway were unchanged. No persistent key or encrypted live archive was
  created in this round.
- Exit live check: Gateway active/running, healthz live, port 19021 listening,
  recent warning-or-higher journal empty, and live V2 table count 0.
- Cleanup removed generated `node_modules` and the superseded v4 receipt; the
  repository is clean and only the 0600 v5 evidence receipt remains.
- State hygiene still reports the same 68 unrelated outside-workspace findings;
  none was created or modified by this bundle.

## Phase 7C — Encrypted live snapshot and readiness gate

- [x] Keep the 76 unowned manual rows candidate-only; do not infer Joy identity.
- [x] Create an independent 32-byte archive key in the 0700 state SecretRef
      area; key file mode is 0600 and key material is not logged or documented.
- [x] Create a 0600 AES-256-GCM live archive and restore-test it to a disposable
      path; source truth remained stable at 952 rows.
- [x] Verify archive checksum, schema digest, logical truth digest, SQLite
      integrity, foreign keys, and plaintext/WAL/SHM cleanup.
- [x] Bind the v5 attribution preflight and encrypted-snapshot receipt into a
      fresh 0600 V2-write readiness receipt.
- [x] Re-run the complete release gate: 162/162 tests, typecheck, build, vector
      smoke, golden recall, and 349-file package scan PASS.
- [x] Verify Gateway active/running, healthz live, port 19021 listening, recent
      warnings empty, and V2 table count still 0.
- [ ] Wait for a separate explicit V2-write approval. Current readiness records
      `authorizesV2Writes=false`, `operatorApprovalPresent=false`, and
      `writeActivationAllowed=false`.

## Phase 7D — Approved additive live V2 write rollout

- [x] Bind a 0600 operator approval to the exact rollout id, approved readiness,
      implementation commit, V1 fallback, and explicit ContextEngine/cutover denial.
- [x] Apply Truth V2, FTS, vector-fallback, relation-projection, rollout-ledger,
      and Experience schemas in one `BEGIN IMMEDIATE` transaction.
- [x] Preserve all 952 V1 truth rows and V1 FTS/vector fallback without rewriting
      or deleting any legacy row.
- [x] Migrate 952 V2 rows as 0 active, 632 candidate, and 320 archived.
- [x] Converge 952 FTS, 952 vector-fallback, 952 relation-projection, and 2,856
      processed outbox rows with zero pending rows.
- [x] Verify SQLite integrity, foreign keys, V1 doctor, Gateway/healthz/port,
      warning logs, repository cleanliness, and owner-only rollout receipts.
- [x] Keep live runtime mode `shadow`, compatibility ContextEngine, V1 reads,
      and the existing shadow approval pointers unchanged; no restart occurred.

## Phase 0 verification

- Focused Memory Address V2 tests: 8/8 PASS.
- Full plugin tests: 96/96 PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run smoke:clawlore-address-v2`: PASS.
- `npm run release:gate`: PASS; pack scan 222 files.
- Live extension/config/database/Gateway: unchanged.

## Phase 1A verification

- Focused ContextPack/adapter tests: 6/6 PASS.
- Full plugin tests: 102/102 PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- ContextPack V1 smoke: PASS; one bounded retrieval; no hook mutation.
- Address V2 and vector-repair smokes: PASS.
- Golden recall: recall 1.0; forbidden violations 0.
- `npm run release:gate`: PASS; pack scan 234 files.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 1B verification

- Focused legacy-source/comparison tests: 6/6 PASS.
- Full plugin tests: 108/108 PASS.
- `npm run typecheck` and `npm run build`: PASS.
- Legacy shadow smoke: PASS; 3 hook outputs -> 1 ContextPack; deterministic.
- Safe fixture candidate preservation: 5/5; unexplained rejection 0.
- Address V2, ContextPack V1, and vector-repair smokes: PASS.
- Golden recall: recall 1.0; forbidden violations 0.
- `npm run release:gate`: PASS; pack scan 243 files.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2A verification

- Agent facade/ContextEngine focused tests: 2/2 PASS.
- Full plugin tests: 119/119 PASS.
- `npm run typecheck` and `npm run build`: PASS.
- Release gate: PASS; pack scan 265 files.
- Golden recall: recall 1.0; forbidden violations 0; prompt budget exceeded 0.
- The first release-gate run correctly exposed stale discoverability assumptions;
  the gate contract was updated and the complete gate then passed.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2B verification

- Module-boundary tests: 2/2 PASS.
- Snapshot/restore tests: 2/2 PASS.
- Full plugin tests: 123/123 PASS.
- `npm run typecheck`, build, vector-repair smoke, golden recall, and release
  gate: PASS.
- Release gate pack scan: 275 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2C verification

- Migration apply/rollback tests: 2/2 PASS.
- Full plugin tests: 125/125 PASS.
- Typecheck/build/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 279 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2D verification

- Encrypted archive tests: 3/3 PASS.
- Full plugin tests: 128/128 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 283 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- First focused run exposed plaintext SQLite WAL/SHM cleanup debt; cleanup was
  repaired and the focused/full gates then passed.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2E verification

- Projection convergence tests: 2/2 PASS.
- Full plugin tests: 130/130 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 287 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 3A verification

- Unified legacy-trigger tests: 2/2 PASS.
- Full plugin tests: 132/132 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 291 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 4A verification

- Memory Center tests: 2/2 PASS.
- Full plugin tests: 134/134 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 299 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- The first historical-conflict regression run exposed a stale test expectation
  after adding a second correction fixture; the expectation was corrected and
  the complete gates then passed.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 5A verification

- Subagent/Experience lifecycle tests: 2/2 PASS.
- Full plugin tests: 136/136 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 311 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- The first typecheck exposed direct experimental `node:sqlite` type coupling;
  the storage adapter was aligned with the existing runtime-load boundary.
- Review then found active snapshots after child completion and missing evidence
  ownership checks; finalization is now atomic and ownership is enforced.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 6A verification

- Release-readiness/support-bundle tests: 3/3 PASS.
- Full plugin tests: 139/139 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 319 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- The first compatibility test assumed a nonexistent `cli.commands` manifest
  node; it was corrected to the actual top-level `commandAliases` contract.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 6B verification

- Runtime composition tests: 5/5 PASS.
- Fixture-host JSON smoke: PASS; disabled hooks 0, shadow hooks 1.
- Shadow receipt: completed; retrieval invoked; one safe candidate selected.
- Tool registrations 0; writes disabled; prompt mutation disabled; ContextEngine registration disabled.
- Full plugin tests: 144/144 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 324 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 6C verification

- Live Gateway: `active/running`; port 19021 `/healthz` returned live.
- Runtime receipt: `registered`, mode `shadow`, hooks 1, writes false, prompt
  mutation false, ContextEngine false.
- Registered observer: `message_received`; live source/dist hashes match the
  isolated candidate.
- Real Telegram direct trace: identity pass, policy pass, retrieval invoked,
  candidates 0, selected 0; trace file remains 0600 and contains no raw message
  or principal identifier.
- Live V2 table count: 0 across the complete Truth/Experience V2 table set.
- Full plugin tests: 149/149 PASS; typecheck/build/runtime composition/module
  boundary/vector repair/golden recall/release gate PASS; pack scan 330 files.

Run report:
`projects/clawlore-v2/docs/clawlore-v2/eval/phase6c-live-shadow-run-2026-07-12.md`.

## Phase 6D observation-audit verification

- Focused audit tests: 3/3 PASS (safe aggregate, unexpected payload rejection,
  group-readable permission rejection).
- First live audit: PASS; mode 0600, samples 6, accepted samples 1, retrieval
  invoked 1, issues 0, positive-candidate samples 0.
- Full plugin tests: 152/152 PASS; typecheck/build/release gate PASS; pack scan
  333 files.
- Post-restart direct observation: 3/3 accepted direct/private samples; identity
  and policy pass 3/3, retrieval invoked 3/3, positive-candidate samples 3/3,
  maximum candidate count 5, and trace issues 0.
- Authorized Telegram group observation: `group` / `conversation`, identity
  pass, `same_conversation` policy pass, retrieval invoked, 6 candidates, 0
  selected, and explicit `private_principal_mismatch` rejection.
- Final observation receipt: mode 0600, decision `go`, no blockers; 6 accepted
  direct/private samples, 1 accepted group/conversation sample, 6 positive
  candidate samples, maximum candidate count 6, issues 0. It explicitly keeps
  writes, prompt mutation, and ContextEngine false and
  `authorizesV2Writes=false`.
- Receipt regression bundle: focused 5/5, full 154/154, typecheck/build/release
  gate PASS; pack scan 334 files.

Run report:
`projects/clawlore-v2/docs/clawlore-v2/eval/phase6d-shadow-observation-audit-run-2026-07-12.md`.

## Boundaries

- Phase 6C authorizes only the currently deployed read-only shadow observer.
- Do not mutate the live memory database or enable V2 writes without the
  separate Phase 7 readiness and operator-approval gate.
- Do not select the ContextEngine slot or enable prompt mutation.
- Do not rename package, CLI, config root, tools, or data paths.
- Do not replace the three legacy prompt hooks until shadow comparison passes.
