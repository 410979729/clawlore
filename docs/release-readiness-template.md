# ClawLore Release Readiness Template

Use this template for each release candidate.

## Candidate

- Package:
- Version:
- Commit:
- Date:
- Operator:

## Source Evidence

- `npm test`:
- `npm run typecheck`:
- `npm run smoke:vector-repair`:
- `npm run build`:
- `node scripts/golden-benchmark.mjs`:
- `npm run release:gate`:

## Package Evidence

- `npm pack --dry-run --json` file count:
- Package scan result:
- Notable included docs:

## Live Evidence

- Live extension backup:
- Live extension path:
- Plugin inspect status/version:
- Doctor status:
- Dashboard status:
- Digest status:
- Experience status:
- Safe recall probe:

## Decision

- Release decision:
- Remaining degraded fields:
- Rollback path:
