# ClawLore v1 canonical identity transition run — 2026-07-15

## Decision

The plugin source is audit-ready under the canonical `ClawLore` / `clawlore`
identity. It is not deployed and is not authorized for live cutover. The exact
committed candidate must receive an independent Tianxuan audit before the
repository is created/renamed or any push/deployment proceeds.

## Changed identity surfaces

- npm package: `clawlore@1.2.0`;
- OpenClaw plugin id/name: `clawlore` / `ClawLore`;
- config root: `plugins.entries.clawlore.config`;
- primary command: `openclaw clawlore`;
- default extension: `extensions/clawlore`;
- default data/OAuth locations: ClawLore-named paths;
- source project and current documentation paths: `projects/clawlore`,
  `docs/clawlore`, and `TODO-clawlore.md`;
- repository metadata: `410979729/clawlore`.

Compatibility is bounded and tested: `scope-recall-openclaw` remains a legacy
plugin id, `scope-recall` and `memory-pro` remain CLI aliases, existing legacy
data/OAuth paths are reused when canonical paths do not exist, and the stable
`scope_recall_*` dynamic-tool ids remain wire contracts.

## Verification

- clean dependency resolution: `npm ci --include=dev`, 0 vulnerabilities;
- clean-copy reproducibility gate: 270/270 tests, typecheck/build, and
  CycloneDX SBOM PASS from a temporary source tree without `.git` or
  `node_modules`; package-lock SHA-256
  `6198244ce16ac87f0611aa214a4fb0d1220f920ca756f90639ea331652bf53fd`;
- full tests: 270/270 PASS;
- TypeScript: `npm run typecheck` PASS;
- compiled artifact: `npm run build` PASS;
- vector repair smoke: PASS;
- golden recall: 4/4 expected hits, recall 1.0, top-k accuracy 1.0,
  forbidden violations 0;
- source release gate: PASS;
- package-lock SBOM: 42 components;
- npm pack scan: 569 files, no blocked runtime/sensitive artifacts;
- isolated OpenClaw beta.5 host inspect: `clawlore@1.2.0` loaded, enabled,
  activated, with commands `clawlore`, `scope-recall`, and `memory-pro`;
- default live gate: expected FAIL because
  `extensions/clawlore` does not exist before deployment.

`openclaw plugins validate` was not counted as evidence because that command
validates only simple `defineToolPlugin` metadata, while ClawLore is a standard
memory plugin. The isolated host inspect above exercises the applicable plugin
loader and command-registration path.

## Live non-mutation evidence

After the source work, the live memory slot and only matching plugin entry were
still `scope-recall-openclaw` 1.1.0. The canonical `clawlore` entry was absent.
Gateway remained `active/running` and `/healthz` returned `ok=true`. Live
ClawLore remained `shadow` with compatibility ContextEngine. No live extension,
config, database, or service mutation was performed.

## Release boundary

The target GitHub repository `410979729/clawlore` did not exist at verification
time, so `origin` was intentionally left unchanged and no push was attempted.
After Tianxuan accepts the exact candidate, create or rename the destination,
verify it, update `origin`, and push only the audited commit.

Any live identity migration is a separate operation. It must follow
`../identity-transition-v1.md`, stage exactly one canonical plugin copy, switch
extension/config/slot atomically, preserve data and no-cutover controls, and
retain full rollback evidence.
