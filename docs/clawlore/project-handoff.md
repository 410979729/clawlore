# ClawLore v1 project handoff

Current through Phase 9, H1-H5 production hardening, the R1 canonical identity
transition, and four independent-audit remediation rounds on 2026-07-15.

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

The second independent audit found and the source candidate now closes three
additional release blockers: SQL-truth/vector-companion read consistency,
Experience Kernel principal isolation, and cross-session auto-recall cache
identity. It also closes degraded-capture injection, raw diagnostic previews,
package content scanning, and credential-at-rest findings. Verification now
covers 301 tests, a 124-case annotated synthetic recall matrix, a 200,000-row
SQLite FTS baseline, SecretRef-aware CLI registration, package-lock SBOM, and
an extracted npm-pack content scan. See
`eval/clawlore-v1-second-independent-audit-remediation-run-2026-07-15.md`.

The third independent audit then exercised authority-outage and transaction
fault paths. The candidate now fails closed whenever an existing SQL-truth
architecture cannot initialize; commits truth, FTS, and durable vector intent
atomically; commits Experience playbook state, FTS, version receipts, and
feedback counters atomically using post-change snapshots; continues bounded
vector scans past stale companion rows; and exposes stable redacted tool errors.
The release workflow starts from a lockfile clean install, validates dependency
integrity, and treats advisory endpoint failures as failures. Verification now
covers 313 tests. See
`eval/clawlore-v1-third-independent-audit-remediation-run-2026-07-15.md`.

The fourth independent audit then reproduced two post-restart/post-commit
consistency gaps. Ordinary startup no longer performs vector-to-truth
reconciliation, so a failed companion delete cannot resurrect a memory after
restart; a missing SQL authority beside non-empty companion data is now the
distinct fail-closed `SQL_TRUTH_MIGRATION_REQUIRED` state. File privacy
enforcement runs before SQLite savepoint release for every durable mutation,
including repair-debt creation/clear, so a `0600` failure rolls truth, FTS, and
outbox state back together. Playbook receipts now contain complete durable
snapshots with recursive secret/path redaction. Initialization outages are
latched until explicit recovery, scan-budget truncation is observable, raw
internal tool errors are fully redacted, and source-only gates reject
post-build dirty trees. Verification covers 321 tests. See
`eval/clawlore-v1-fourth-independent-audit-remediation-run-2026-07-15.md`.

The exact clean code commit `d83036e9d05f4ea509b232039cab3ef28e01608a`
repeated the full lockfile-clean source gate: 321/321 tests, typecheck, build,
vector repair, 124/124 deterministic recall with zero cross-scope leakage,
the 200,000-row SQLite FTS baseline, official-registry audit with zero known
production vulnerabilities, a 42-component SBOM, and an 182-file extracted
pack scan. Its recursive runtime digest was
`72675fa14301e6017e758a057fbffa048a73beb8ac2d5eaf834ce51ba2321831`.
Isolated OpenClaw `2026.7.1-beta.5` loaded and activated the package, exposed
all three command identities, and returned `doctor ok=true` after isolated
Experience schema initialization.
The final documentation-only descendant repeated the same clean source gate;
the delivered commit is the repository HEAD named in the handoff message, and
the recursive runtime digest remains unchanged.

This candidate does not authorize a live rename, V2 writes, lifecycle
promotion, ContextEngine, prompt mutation, or final-recall cutover. Tianxuan's
re-audit of the exact clean remediation commit is the next gate; repository
creation/rename and push follow only after that audit is accepted.

## Current live boundary

The 2026-07-14 H5 artifact remains the deployed runtime under the legacy plugin
identity. H5 completed recovery, exact deployment, schema-v3 acceptance,
post-restart probes, bounded soak, and a fresh `no_cutover` decision. Its exact
deployed runtime digest was
`c4e43382dbbf09379e51ba1334a8574fcf1369a496f7bb1246cdeb0c455d2251`.

Live behavior remains V1 fallback plus ClawLore read-only shadow. Telegram is
sender-allowlisted, every configured group plus the wildcard group denies the
declared memory/governance tool surface, the service uses `UMask=0077`, and
SQLite/WAL/SHM are `0600`. Runtime model credentials are SecretRefs. V2 writes,
lifecycle promotion, ContextEngine, prompt mutation, and final recall remain
disabled. The 1.2 source candidate has intentionally not changed live extension
files, database truth, memory slot, or V2 rollout controls.

The H5 report is
`eval/clawlore-v1-h5-production-deployment-run-2026-07-14.md`.

## Why cutover remains closed

Phase 9 and H5 both found real production debt: no active/injectable/eligible
V2 memories, unresolved verification/principal debt, unapplied archive
proposals, current V1/V2 content differences, and no separately authorized
runtime cutover implementation. `no_cutover` is a completed safety decision,
not an implied approval to switch later without fresh evidence.

## Next controlled boundary

1. Give Tianxuan the final clean HEAD, this handoff, the identity-transition runbook, and
   all dated audit-remediation reports for independent read-only re-audit.
2. If the audit passes, create or rename the GitHub repository to `clawlore`,
   verify the destination, then update `origin` and push the audited commit.
3. Treat any live identity migration as a separate backup-backed rollout with
   an atomic config/extension switch, post-restart gates, and rollback evidence.
