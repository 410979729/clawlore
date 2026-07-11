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

## Boundaries

- Do not edit or deploy to the live extension during isolated Phase 1 work.
- Do not open or mutate the live memory database.
- Do not select the ContextEngine slot or restart Gateway.
- Do not rename package, CLI, config root, tools, or data paths.
- Do not replace the three legacy prompt hooks until shadow comparison passes.
