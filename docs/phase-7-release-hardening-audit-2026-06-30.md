# Phase 7 Release Hardening Audit - 2026-06-30

Scope: commercial memory plugin plan Phase 7.

## Model And Execution Gate

- Current session model was re-verified before this phase audit:
  `openai/gpt-5.5`.
- Current thinking mode was re-verified as `xhigh`.

## Changes Audited

Phase 7 hardens the source/package/live boundary so release claims can be
checked from evidence rather than memory or model self-report.

Files changed or verified:

- `scripts/release-gate.mjs`
  - Requires Phase 5, Phase 6, and Phase 7 audit docs.
  - Requires operator runbook and release-readiness template docs.
  - Checks digest, replay, and package-hygiene markers.
  - Parses `npm pack --dry-run --json` and fails on runtime databases, logs,
    backups, `node_modules`, temporary/archive directories, credentials, tokens,
    or secret-shaped artifact paths.
  - Expands workspace/live drift checks to include CLI, digest, replay,
    contract docs, and commercial benchmark fixtures.
- `docs/operator-runbook.md`
  - Defines source gate, live rollout, live smoke, and rollback sequence.
- `docs/release-readiness-template.md`
  - Defines the evidence fields required before a release statement.
- `README.md` and `CHANGELOG.md`
  - Document the digest, replay, and release-hardening surface.

## Verification

Required verification for this phase:

```bash
npm run release:gate
OPENCLAW_HOME=/home/a/openclaw-tianji/home/state openclaw plugins inspect scope-recall-openclaw
OPENCLAW_HOME=/home/a/openclaw-tianji/home/state openclaw scope-recall doctor --json --quiet
OPENCLAW_HOME=/home/a/openclaw-tianji/home/state openclaw scope-recall dashboard --json
```

For live rollout, sync only after source gate passes, and record evidence in
the release-readiness template.

## Audit Findings

- A release can now be checked at source, package, and live extension layers.
- The package scan is explicit and fails closed on common local-runtime and
  secret-shaped artifacts.
- Live extension drift is part of the release gate, so a source-only feature
  cannot be silently described as live.

## Remaining Risk

- Package scan is path-based. It catches common leak classes but does not
  replace ClawHub or external malware/credential scanning.
- Live smoke still depends on the target Gateway and must be re-run per
  deployment.
