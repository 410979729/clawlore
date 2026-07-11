# Phase 6A compatibility and release readiness run — 2026-07-12

## Scope

This isolated slice freezes compatibility identities, defines stable readiness
receipts, produces mode-aware rollout previews, and adds redacted support bundle
output. It does not approve or apply a live rollout.

## Contracts

- Preserve package and manifest id `scope-recall-openclaw`.
- Preserve config root `plugins.entries.scope-recall-openclaw.config`.
- Preserve CLI `scope-recall` and alias `memory-pro`.
- Preserve existing data paths and historical source metadata for at least one
  major compatibility cycle.
- Shadow requires code/eval gates and zero forbidden-scope violations, remains
  read-only, and still requires explicit operator approval.
- V2 write/cutover additionally require verified snapshot, migration drill,
  rollback drill, and proof that the legacy hash remained unchanged.
- Rollout previews never self-approve and always list mutation/rollback steps.
- Support bundles recursively redact credential-shaped keys and values,
  authorization, private keys, and local paths.

## Verification

- `npm run smoke:clawlore-release-readiness`: 3/3 PASS.
- `npm run smoke:clawlore-module-boundaries`: 2/2 PASS.
- `npm test`: 139/139 PASS.
- Typecheck/build/vector-repair: PASS.
- Golden recall: recall 1.0; top-k 1.0; forbidden violations 0; prompt budget exceeded 0.
- Release gate: PASS; package scan 319 files.

The first compatibility test addressed a nonexistent `cli.commands` node. The
live manifest contract uses top-level `commandAliases`; the test was corrected
and all gates rerun.

## Live boundary and next slice

No live changes or approvals occurred. Next is the minimal default-off runtime
composition root and schema flag, followed by a fixture host smoke proving that
disabled mode registers no V2 hook and shadow mode emits only redacted receipts.
