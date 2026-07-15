# ClawLore v1 H4 reproducible release identity run

Date: 2026-07-14

## Outcome

H4 is complete in candidate source. Release validation no longer treats a
missing live extension as success, runtime identity is recursive and
digest-based, dependencies are locked, and a clean install/build/SBOM run is
reproducible.

## Controls delivered

- `release:gate` requires a real live extension and verifies the inspected
  runtime root before making a live claim.
- `release:gate:source` is the only explicit source-only path and records that
  it does not claim live identity or runtime health.
- Runtime identity covers every regular file below `dist/` plus the package and
  plugin manifests. Missing, extra, changed, or symlinked runtime files fail.
- Candidate receipts name both the Git commit and recursive runtime digest;
  live mode also requires a clean worktree.
- `package-lock.json` is committed. The reproducibility gate uses
  `npm ci --ignore-scripts --include=dev` in an isolated source copy, then runs
  the full test, typecheck, build, and CycloneDX SBOM gates.

## Verification

- Focused artifact identity regression: PASS.
- Full tests: 267/267 PASS.
- Typecheck: PASS.
- Build: PASS.
- Source-only release gate: PASS; it emitted an explicit no-live-claim receipt.
- Missing live target negative probe: PASS; the gate failed before tests.
- Clean reproducibility gate: PASS; 40 packages installed from the lockfile,
  267/267 tests passed, typecheck/build passed, and the SBOM contained 42
  components.
- Lockfile SHA-256:
  `822d87cc054f3494499a6d667ac0dc6e0c984d2513892f29bd66f6422fd61013`.

The first clean-install attempts exposed two environment-dependent lockfile
defects: production-mode omission of dev dependencies, followed by local-link
entries inherited from the live `node_modules` symlink. H4 fixes both at the
root: the gate explicitly includes dev dependencies and the lockfile was
regenerated without any live dependency link. No failed temporary tree was
retained.

## Live boundary

This run did not change the live extension, configuration, database, or
Gateway. Exact candidate/live matching and deployment belong to H5.
