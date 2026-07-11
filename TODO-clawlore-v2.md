# ClawLore 2.0 TODO

Updated: 2026-07-11

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

## Next slice candidates

- [ ] Audit 1.x SecretRef support, plaintext backup, startup compaction, and
      management-tool discovery as a separate hardening patch.
- [ ] Design a default-off runtime shadow flag and trace sink without replacing hooks.
- [ ] Design additive v2 SQLite tables and migration preview against a fixture.

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

## Boundaries

- Do not edit or deploy to the live extension during isolated Phase 1 work.
- Do not open or mutate the live memory database.
- Do not select the ContextEngine slot or restart Gateway.
- Do not rename package, CLI, config root, tools, or data paths.
- Do not replace the three legacy prompt hooks until shadow comparison passes.
