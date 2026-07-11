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

## Next slice candidates

- [ ] Define the ContextPack schema and one compatibility Context Composer.
- [ ] Add runtime `senderId` evidence to an adapter without changing recall.
- [ ] Design additive v2 SQLite tables and migration preview against a fixture.
- [ ] Audit 1.x SecretRef support, plaintext backup, startup compaction, and
      management-tool discovery as a separate hardening patch.

## Phase 0 verification

- Focused Memory Address V2 tests: 8/8 PASS.
- Full plugin tests: 96/96 PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run smoke:clawlore-address-v2`: PASS.
- `npm run release:gate`: PASS; pack scan 222 files.
- Live extension/config/database/Gateway: unchanged.

## Boundaries

- Do not edit or deploy to the live extension in Phase 0.
- Do not open or mutate the live memory database.
- Do not select the ContextEngine slot or restart Gateway.
- Do not rename package, CLI, config root, tools, or data paths.
