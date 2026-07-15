# ClawLore v1 project handoff

Current through Phase 9, H1-H5 production hardening, the R1 canonical identity
transition, and six independent-audit remediation rounds through 2026-07-16.

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

The fifth remediation round closes the remaining authority-provenance and OAuth
persistence gaps. Existing SQL files are inspected read-only before any schema
mutation and must carry a versioned authority marker; zero-byte, empty,
schema-less, partial, corrupt, or unreadable files fail closed instead of being
auto-healed into empty truth. Fresh marker creation is limited to a genuinely
empty install, while a complete non-empty legacy truth has one controlled
upgrade path. OAuth refresh now uses same-directory exclusive temporary writes,
fsync, private-mode/ACL enforcement, symlink refusal, atomic rename, and parent
directory sync. Callback state is checked before provider errors and HTML is
escaped. Diagnostics, recovery documentation, sqlite companion startup probes,
and Windows/POSIX privacy policy are aligned. Verification now covers 335 tests.
See `eval/clawlore-v1-fifth-independent-audit-remediation-run-2026-07-15.md`.

The exact clean code commit `06a7d4bb5c343b7bacc920fcc0e5ca3b82103404`
repeated the full lockfile-clean source gate: 335/335 tests, typecheck, build,
vector repair, 124/124 deterministic recall with zero cross-scope leakage,
the 200,000-row SQLite FTS baseline, official-registry audit with zero known
production vulnerabilities, a 42-component SBOM, and a 183-file extracted
pack scan. Its recursive runtime digest was
`965540c5fb665d0ad4b351800459ef652c963612547d0426327516aefedc334a`.
Isolated OpenClaw `2026.7.1-beta.5` loaded and activated the package, exposed
all three command identities, and returned `doctor ok=true` after isolated
Experience schema initialization.
The final documentation-only descendant repeated the same clean source gate;
the delivered commit is the repository HEAD named in the handoff message, and
the recursive runtime digest remains unchanged.

The sixth remediation round closes the fifth audit's migration, ACL, OAuth
read, listener, packaging, and evidence gaps. SQL-authority inspection now
checks exact table kinds and columns, including an actual FTS5 virtual table;
ordinary startup never upgrades a legacy authority. The explicit migration
requires a verified backup and receipt, performs schema/FTS/marker work inside
one savepoint, and writes the marker last. Windows privacy is default-deny:
the current service SID must own the file and be the sole protected allow ACE.
OAuth reads now verify a private parent and file, reject symlinks, use
`O_NOFOLLOW`, and compare opened-file identity; the callback listener is ready
before the authorize URL is exposed. SQLite parent privacy is established
before open and expensive Windows ACL commands no longer run under the write
lock. OAuth diagnostics expose stable identifiers rather than absolute paths.

The release contract now distinguishes source-only scripts from the one packed
runtime smoke. The source gate builds the final tarball, installs it into an
empty production directory, then installs that same tarball through an
isolated real OpenClaw CLI and exercises extension activation, `clawlore`, both
legacy aliases, authority inspection, Experience initialization, and doctor.
Generated evidence binds the exact commit, runtime digest, pack count, SBOM
count/hash, registry, and both packed smokes. The exact clean code commit
`9aa7d2e29661f66bca6988db091b59770da7561f` passed 349/349 tests,
typecheck, build, vector repair, 124/124 deterministic recall, the 200,000-row
SQLite FTS baseline, official-registry production audit with zero known
vulnerabilities, a 42-component SBOM, and a 185-file pack scan. Build left the
tree clean. The recursive runtime digest is
`da95777445aeca89e5ef497ee3c270aeb859e05bee0e7b21e79cf70694db0cc4`.
See
`eval/clawlore-v1-sixth-independent-audit-remediation-run-2026-07-16.md`.

This Linux acceptance run exercises the Windows policy through deterministic
command/ACL fixtures; it does not claim a real second-account Windows ACL or
concurrent-write benchmark. That remains an independent platform-validation
item and does not authorize weakening the default-deny policy.

The sixth independent review then found five deeper blockers in the new
migration/platform boundary. The seventh remediation closes them without
deploying the candidate. Windows ACL enforcement now uses an encoded
PowerShell program with path/SID/kind supplied through structured environment
input instead of string-form `-Command` arguments. SQL authority validity is
bound to an exact schema fingerprint covering primary keys, constraints,
indexes, triggers, outbox, marker/migration tables, and the FTS5 definition.
Migration canonicalizes source/backup/receipt identities, rejects relative and
symlink-parent aliases before writes, requires separate dedicated private leaf
directories, fsyncs the backup and parent, and compares an exact logical
snapshot under a SQLite writer lock before committing the marker. Existing
parents are verified but never chmod'd or have ACLs rewritten. The internal
SQLite migration receipt is commit truth and can idempotently reconstruct an
interrupted external completed receipt.

Release scripts now use a cross-platform Node wrapper, TypeScript strict mode
is enabled, unreachable vector-first fallback branches are removed, and the
final installed tarball runs both native-free and native LanceDB
store/reopen/delete/repair smokes plus the isolated real OpenClaw CLI smoke.
Machine-generated evidence for exact clean code commit
`854591269632d31e03d5fc500ebdc4168d7257f4` records 361 tests passed, 0
failed, one Windows-only integration skipped on Linux, runtime digest
`0883f4b2fd7ad419f88b5784c2741c190dbdc95c838e4d44b98a0f5b78bcb270`,
42 SBOM components, 186 package files, official-registry production
vulnerabilities 0, all three packed smokes true, and `dirty=false`. See
`eval/clawlore-v1-seventh-independent-audit-remediation-run-2026-07-16.md` and
`eval/clawlore-v1-seventh-release-evidence-2026-07-16.json`.

The real Windows second-account test remains an explicit evidence limitation:
the authorized Windows client was unreachable over its registered management
path during this run. The conditional real-PowerShell test is present and will
run on Windows CI; Linux fixtures prove command construction and default-deny
ACL evaluation but are not misrepresented as a Windows canary.

The live Gateway port source was separately aligned from stale config `19421`
to the service/listener truth `19021` under a controlled backup. That config
restart did not deploy the candidate or alter the memory data plane.

This candidate still does not authorize a live rename, V2 writes, lifecycle
promotion, ContextEngine, prompt mutation, or final-recall cutover. Tianxuan's
re-audit of the exact delivered clean HEAD is the next gate; repository
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
