# ClawLore v1 project handoff

Current through Phase 9, H1-H5 production hardening, and the R1 canonical
identity source candidate on 2026-07-15.

## Canonical identity candidate

The source candidate is consistently named `ClawLore` / `clawlore` across the
npm package, OpenClaw manifest id, config root, primary CLI, repository
metadata, default data path, extension target, logs, docs, and compiled output.
It remains on the ClawLore v1 product line; internal `V2` names describe the
second-generation data architecture.

Compatibility is explicit rather than accidental:

- `scope-recall-openclaw` is a legacy plugin id;
- `scope-recall` and `memory-pro` are CLI aliases;
- old data/OAuth paths are reused only when canonical paths do not exist;
- stable `scope_recall_*` dynamic-tool ids remain wire contracts.

Loading legacy and canonical plugin copies together is forbidden because they
expose the same memory slot, hooks, and tool ids.

Identity verification currently passes 270/270 tests, typecheck, build, vector
repair, golden recall, package-lock SBOM (42 components), npm pack scan (569
files), and the explicit source-only release gate. The default live gate now
targets `extensions/clawlore` and must remain fail-closed until an independently
audited artifact is deployed. See `identity-transition-v1.md` and
`eval/clawlore-v1-identity-transition-run-2026-07-15.md`.

This candidate does not authorize a live rename, V2 writes, lifecycle
promotion, ContextEngine, prompt mutation, or final-recall cutover. Tianxuan's
audit is the next gate; repository creation/rename and push follow only after
that audit is accepted.

## Current live boundary

The 2026-07-14 H5 artifact remains the deployed runtime under the legacy plugin
identity. H5 completed recovery, exact deployment, schema-v3 acceptance,
post-restart probes, bounded soak, and a fresh `no_cutover` decision. Its exact
deployed runtime digest was
`c4e43382dbbf09379e51ba1334a8574fcf1369a496f7bb1246cdeb0c455d2251`.

Live behavior remains V1 fallback plus ClawLore read-only shadow. V2 writes,
lifecycle promotion, ContextEngine, prompt mutation, and final recall remain
disabled. The R1 source candidate has intentionally not changed live config,
extension files, database, or service.

The H5 report is
`eval/clawlore-v1-h5-production-deployment-run-2026-07-14.md`.

## Why cutover remains closed

Phase 9 and H5 both found real production debt: no active/injectable/eligible
V2 memories, unresolved verification/principal debt, unapplied archive
proposals, current V1/V2 content differences, and no separately authorized
runtime cutover implementation. `no_cutover` is a completed safety decision,
not an implied approval to switch later without fresh evidence.

## Next controlled boundary

1. Commit the exact R1 candidate and record its recursive runtime digest.
2. Give Tianxuan the commit, this handoff, the identity-transition runbook, and
   the dated R1 evaluation report for independent read-only audit.
3. If the audit passes, create or rename the GitHub repository to `clawlore`,
   verify the destination, then update `origin` and push the audited commit.
4. Treat any live identity migration as a separate backup-backed rollout with
   an atomic config/extension switch, post-restart gates, and rollback evidence.
