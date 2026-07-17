# ClawLore v1 project handoff

Current through Phase 9, H1-H5 production hardening, the R1 canonical identity
transition, the seventh and eighth independent reviews, and R2 brand/
architecture bundle 5 through 2026-07-17.

## R2 architecture closure — independent audit entry

The requested brand and architecture convergence has reached the independent
source-audit boundary. It is not a deployment or release acceptance.

- `index.ts` is a 632-line composition root, down from 4,730 lines. Markdown
  compatibility, runtime construction, runtime-shadow registration, and five
  capability hook families have explicit owners.
- `cli.ts` is a 198-line facade. CLI, memory tools, and Experience tools are
  split by capability with shared policy and exact public-export regressions.
- `MemoryStore` is a compatibility facade over explicit truth, retrieval,
  projection, and transaction ports. The existing transaction implementation
  and its fault/authority/privacy tests remain intact.
- Stable current-product application and OpenClaw adapter modules use canonical
  roots. Old `src/v2` capability paths are pure deprecated re-exports; actual
  persisted/schema/protocol V1/V2 names remain versioned.
- The reverse-dependency ledger shrank from 45 to 44 edges. New production
  modules remain below 800 lines; inherited hotspots are exact shrink-only debt,
  not falsely declared eliminated.

Audit documents:

- `architecture-module-map-v1.md`;
- `compatibility-removal-ledger-v1.md`;
- `comment-contract-audit-v1.md`;
- `eval/clawlore-v1-brand-architecture-refactoring-bundle5-run-2026-07-17.md`.

The evidence-write Linux source gate on exact source candidate `56bce74` passed
418 total / 416 passed / 0 failed / 2 platform skips, strict typecheck/build,
vector repair, 124/124 deterministic recall, the 200,000-row FTS baseline,
all three packed smokes, 42-component SBOM, a 239-file package scan, and zero
official-registry vulnerabilities. Release-input identity is
`6f7edcc2692f8e718b3e0bda6682975a408641ea4354f8ce528af79cef908e27`
across 680 tracked inputs; runtime identity is
`40d827230c0d2e7c48fbe364228eaf69739a75862acb983bfb24a8c3e3cbeb69`.

The release gate itself exposed two split-boundary defects before passing: it
still inspected only monolithic `cli.ts`, and compiled version lookup retained
the old relative depth. Commits `961d2e6` and `56bce74` fix and regress both.
Neither failed run is represented as acceptance evidence.

Remaining Phase H gates are the exact real-Windows Node 24 run, cleanup of the
owned Windows audit roots when that client is reachable, and independent
source review. No live extension/config/data was changed; release and rollout
remain NO-GO.

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

The seventh independent review then found four remaining blockers: ordinary
Windows ancestors were incorrectly held to the final owner-only leaf policy;
Windows rejected backup/receipt fsync through read-only handles; arbitrary-name
SQLite triggers were outside the authority fingerprint; and an external
`status=completed` receipt was trusted without binding its fields to internal
evidence and the backup. The eighth remediation separates trusted-ancestor and
strict-leaf policies, writes and syncs migration artifacts through writable
handles, upgrades authority to schema version 4 with exhaustive protected-
object enumeration plus CRUD characterization, and upgrades external receipts
to a fully bound version 3 contract with verified recovery.

System management reads now preserve the reserved unfiltered bypass while
system mutations require explicit scopes. Compatible legacy vector-repair debt
is included in the logical snapshot and migrated instead of dropped. The
release contract now declares Node 24, Linux/Windows, and an OpenClaw peer
range; a visible two-platform CI matrix runs the same source gate. Canonical
evidence binds tracked release-input content rather than a self-referential
final commit hash and records lockfile, SBOM, toolchain, platform, pack, runtime,
and compatibility identity.

Exact clean code-and-dist commit `b75e0b06e4f2701c670f114a8d1f0a25d6056250`
passed the Linux source gate with 379 passed, 0 failed, one Windows-only skip,
runtime digest
`358a22ef60077035bc40aa4dbfa01b78111d63b395373f18e408bf6531479d22`,
release-input digest
`925923b9bb3ce462e36503ea4c43d18e16b4abe6b5f2e62f7b832ec2d15e9f57`,
42 SBOM components, 186 package files, official-registry vulnerabilities 0,
and all three packed smokes true. See
`eval/clawlore-v1-eighth-independent-audit-remediation-run-2026-07-16.md` and
`eval/clawlore-v1-release-evidence.json`.

The authorized Windows work computer accepted an isolated audit checkout and
Node 24 dependencies under the user's profile. Real-Windows tests exposed and
then drove fixes for POSIX-mode assumptions, output ACL enforcement, leaked
SQLite handles, concurrent OAuth atomic-renames, path separators, and the
release wrapper. A focused run reached the final affected suites before the
client disappeared from the tailnet; the exact final source gate did not
complete. No live plugin, service, system configuration, or user data was
changed. The isolated audit directories still require cleanup when the client
is reachable. Real Windows Node 24 validation therefore remains a release
gate, not a claimed success.

Post-interruption review found that the remaining Windows failures were in the
test harness rather than the production data path: SQL-truth authority tests
removed temporary trees before closing their SQLite/LanceDB stores, and the
legacy-hygiene subprocess used a URL pathname as a Windows filesystem path.
Commit `53c6e65ef3adb125e890841d9aed25e94ccae87e` closes both defects. The
standard gate then exposed a separate release-contract mismatch: CI installed
OpenClaw `2026.7.1-beta.2`, below the package's existing `beta.5` plugin API and
Gateway floor. Commit `0547e7687ba3b025422aeaee49a34de6b8923428`
aligns the optional peer range, gate assertion, CI fixture, and regression
contract at `>=2026.7.1-beta.5 <2027`.

Normal-mode evidence verification commit
`7b439915f562b1df23445ee496481892a68cb8fb`
passed both evidence-write and normal-mode Linux source gates. Each run covered
379 passed, 0 failed, one Windows-only skip, typecheck, build, vector repair,
124/124 recall, the 200,000-row FTS baseline, official-registry vulnerabilities
0, a 42-component SBOM, a 186-file pack, and all three packed smokes against an
isolated real OpenClaw `2026.7.1-beta.5` host. Canonical release-input digest is
`7809597722d215155a7a28d7380e84724ae3468e70c7b65d0cf178249364068b`;
runtime digest is
`82e894c689b7f7873c30cadbc6ab27b722eb1b7bedb897704d5e7515271e5fc5`.
One bounded Windows reconnect at this exact candidate timed out. No repeat polling
or remote mutation followed, so the exact Windows gate and owned audit-root
cleanup remain open.

Normal-mode Linux verification at documentation commit
`37ab56946487e15135c9f98400585386c4e69e8c` then re-ran the same source gate
against the checked-in canonical evidence. All stable evidence fields matched,
the gate again passed 379 tests with one Windows-only skip, and the environment's
44-component SBOM was accepted under the evidence contract's explicitly
declared SBOM/toolchain variance.

Tianxuan's eighth independent read-only review found no new production-path
blocker, but identified two P2 evidence/test-harness gaps. Commit
`3747b8b3ed38c123eb43f0ff175aa34ef3aabcbc` centralizes the exact allowed
evidence variance, compares stable SBOM format/spec/tool fields, adds
counterexample regressions, and guarantees that both SQL authority store pairs
close in `finally` before recursive cleanup. Canonical evidence commit
`da16172ce49da5c5ef53d2865b1200ac1b33eaf8` passed both evidence-write and
normal-mode Linux gates: 382 total / 381 passed / 0 failed / one Windows-only
skip, 124/124 recall, 200,000-row FTS, vulnerabilities 0, 42-component SBOM,
186-file pack, and all three packed smokes. Release-input digest is
`e35ca201ea90dfd1d11b0cc741b27b017664689aa6b49049006aa6528544f6b1` across
556 tracked release inputs; runtime digest remains
`82e894c689b7f7873c30cadbc6ab27b722eb1b7bedb897704d5e7515271e5fc5`.
Tianxuan's focused follow-up independently recomputed both identities, closed
both P2 findings, found no new source blocker, and left the exact worktree
clean and unchanged. Its overall verdict remains NO-GO only because the exact
real-Windows gate and owned audit-root cleanup are still open.

The subsequently restored Windows work computer exposed further defects that
Linux could not model: POSIX mode checks were not Windows DACL checks, several
test/smoke paths deleted SQLite trees before closing handles, reused Windows
checkouts could retain CRLF runtime manifests, and the supply-chain audit
spawned PATH npm instead of the exact npm CLI driving the gate. The source now
uses DACL-aware privacy checks, deterministic store closure, LF runtime
manifests/build output, and `process.execPath + npm_execpath` on Windows.

Tianxuan then independently audited exact candidate
`d4f778134603d348cb7874eb2674d1951d5235a5` and found two P1 blockers. The
release-input digest still read working-tree bytes outside the runtime-only LF
rules, and the shadow observation audit verified a pathname before separately
reading that pathname. Commit `70c07ebd207146f86241cfbbbad929b518bb0e4d`
now enumerates committed `HEAD` blobs and hashes their binary contents; its
regression proves an LF/CRLF working-tree transformation cannot change the
identity while a committed blob change does. Commit
`fc8e5c23d1460a4ceb3c93d5548f2747a9a75624` verifies the containing directory
trust boundary, opens with `O_NOFOLLOW` where available, binds the initial,
opened, and post-open identity, validates opened-handle mode/owner, reads from
that same handle, and closes it in `finally`. A controlled replacement race
fails closed with zero parsed samples.

Canonical evidence commit `df0f80e3105bc6101a6fd78d0eb11a49983390cf`
passed both evidence-write and normal-mode Linux source gates: 385 total / 383
passed / 0 failed / two platform skips, 124/124 recall, the 200,000-row FTS
baseline, official-registry vulnerabilities 0, a 42-component SBOM, a
186-file pack, and all three packed smokes. The canonical Git-blob v2
release-input digest is
`4fb40d68eba161e1f20c53f228a16587d1dee3449d6d13e2030c4b8b534e9f11`
across 559 files. Runtime digest is
`ae1892b1622eacc9db7c207179444696abc8274bc464e79d440af27a6e9cb4a1`.
Tianxuan's exact `df0f80e` focused closure independently recomputed both
identities, closed both P1 findings and the candidate-provenance P2, found no
remaining source/material blocker, and left the worktree unchanged. Its only
new finding is a non-blocking P3: a same-inode permission race may report the
pre-open mode even though the read itself still fails closed.

Real-Windows evidence is substantial but not final for `df0f80e`. An earlier
candidate completed 382 tests with 374 passed, 0 failed, and 8 Windows skips,
then passed typecheck, vector-repair smoke, build, 124/124 recall, the 200,000
row baseline, byte-identical cross-platform runtime identity, and packed
runtime/LanceDB smokes. It stopped at an audit transport failure. The pinned
npm audit fix then passed a standalone Windows vulnerabilities-0 check, but a
later full run lost SSH before returning its final exit code. The work computer
became unreachable again before `df0f80e` could be transferred and fully run.
Therefore overall release status remains NO-GO solely on the exact Windows
gate and owned-directory cleanup; the partial evidence is not promoted to a
pass.

Final live verification was read-only: `openclaw-gateway-tianji.service` was
`active/running`, port `19021` returned `status=live`, and the loaded extension
remained `scope-recall-openclaw@1.1.0`. The live SQLite companion reported
`quick_check=ok`, zero foreign-key violations, truth/FTS `1031/1031`, and
`0600` database/WAL/SHM files. No candidate deployment or restart occurred.

Local clean worktrees and dependency trees created for this run were removed;
the project worktree is clean. The workspace state-hygiene audit still reports
84 items outside the project (historical config/session residues and host-
managed plugin cache documents). They were not generated as project artifacts
and were left untouched because deleting them is outside this release repair.
The isolated Windows audit directories are the only task cleanup still pending,
blocked by client reachability.

The live Gateway port source was separately aligned from stale config `19421`
to the service/listener truth `19021` under a controlled backup. That config
restart did not deploy the candidate or alter the memory data plane.

This candidate still does not authorize a live rename, V2 writes, lifecycle
promotion, ContextEngine, prompt mutation, or final-recall cutover. Tianxuan's
eighth source/material review is complete, but cross-platform acceptance
remains conditional on the real Windows gate and owned-test-root cleanup.
Repository creation/rename and push follow only after those external gates and
a separate release decision.

## R2 brand and architecture bundle 1

Source commit `f7aaf4e0db79c8ebbbc6214bc935317dd0f2cf74` establishes
`runtime` as the canonical ClawLore runtime configuration, retains
`clawloreV2` only as a deprecated conflict-checked alias, replaces current
`clawlore-v2:` log prefixes, and makes new Experience classifications
ClawLore-first without rewriting old persisted values.

The new source-governance gate classifies 174 production TypeScript entries,
sets exact non-growth ceilings on 17 existing hotspots, caps new TypeScript
modules at 800 lines, and confines legacy brand spellings to a non-growth
compatibility ledger. The detailed execution plan is
`clawlore-v1-brand-architecture-refactoring-plan.md`.

Evidence commit `0165239251610f3f8b27fad7128fb6f7753029a5` passed both
evidence-write and normal-mode Linux source gates: 390 total / 388 passed / 0
failed / two platform-condition skips, typecheck, build, vector repair,
124/124 recall, 200,000-row FTS, official-registry vulnerabilities 0,
42-component SBOM, 187-file pack, and all three packed smokes. Release-input
identity is
`5ecf31d547f7936a5bdee3d349a056470fea15b6c89e193372f2935b31e506fd`
across 563 inputs; runtime identity is
`363f87ce789c0e7b9ad967d7a8b9b48723d33651e12204532e96a00c022b2dd6`.

This bundle did not touch live configuration, extension files, database state,
Gateway service state, repository remotes, or the Windows work computer. The
lockfile-built dependency tree and ClawLore `/tmp` artifacts were removed. The
project worktree is clean. The state-hygiene audit reports 86 out-of-project
host/config/session/plugin-cache residues; they were not generated as candidate
artifacts and were left untouched. The full architecture program and
cross-platform/review gates remain open. See
`eval/clawlore-v1-brand-architecture-refactoring-bundle1-run-2026-07-17.md`.

## R2 brand and architecture bundle 2

Code commit `5d3606e46479310f97a1833e45dd81f250837ce5` adds an exact
shrink-only ledger for 45 migration-era reverse dependencies and extracts the
validated plugin configuration contract/parser into `src/plugin-config.ts`.
The parser is 556 lines; `index.ts` keeps composition use plus the public
compatibility re-export and shrinks from 4,730 to 4,184 lines. Five valid and
four invalid parity fixtures matched the old parser before the duplicate was
removed. Four dedicated parser tests cover defaults, numeric normalization,
legacy session behavior, credentials, and canonical/compatibility runtime
input.

The complete source plan candidate `9e0fcfa3705dfb3fab96b7dee001ca65dd3e5839`
passed the evidence-write Linux source gate: 395 total / 393 passed / 0 failed /
two platform skips, typecheck, build, vector repair, 124/124 deterministic
recall, 200,000-row FTS, official-registry vulnerabilities 0, 42-component
SBOM, 188-file pack scan, and packed runtime/LanceDB/OpenClaw CLI smokes.
Release-input identity is
`074832cb1cf41436e0511c4a691d9f16c0f5ca203e59989b701ca538476ef1a0`
across 567 inputs; runtime identity is
`4f31de8b1a782726f785ee78bdb08059d9d57347aee0ea1a3badf989b4e81350`.
Evidence commit `974c04a55e05aa89de52ccabdfa56953a1609228` then passed the
same complete gate in normal mode. The stable release-input and runtime
identities matched; only the evidence contract's declared observed-commit/SBOM
toolchain variance changed.

The lockfile dependency tree was removed after normal verification, `/tmp` had
no ClawLore-named residue, and the project worktree was clean. The workspace
state-hygiene audit still reports 86 out-of-project historical config/session/
plugin-cache items; they were not created by this bundle and were left intact.

This bundle did not deploy, modify live configuration or data, restart the
Gateway, connect to the Windows work computer, push, tag, or release. Overall
status remains NO-GO: reflection/capture/Markdown/runtime/hook extraction,
CLI/tools/storage convergence, the exact Windows gate, cleanup of only the
owned Windows audit roots, and independent review remain open. See
`eval/clawlore-v1-brand-architecture-refactoring-bundle2-run-2026-07-17.md`.

## R2 brand and architecture bundle 3

Code commit `799dbcf650f4857b21d8fd725e8b03ef5192f9d8` extracts the
reflection-specific entry-point slice into four bounded modules:

- `reflection-contracts.ts` owns shared domain types;
- `reflection-transcript.ts` owns message filtering/redaction, JSONL reading,
  reset fallback, and previous-session recovery;
- `reflection-generation.ts` owns the exact prompt, embedded-runner boundary,
  timeout/retry behavior, and structured fallback;
- `reflection-command-orchestrator.ts` owns the access-gated
  `command:new`/`command:reset` use case through explicit store, embedding,
  learning, cache, and diagnostic ports.

`index.ts` retains state shared with reflection injection plus dependency
composition and hook registration. It shrinks from 4,184 to 3,336 lines. The
four new production modules are each below 800 lines, all are classified, and
the 45-edge reverse-dependency debt ledger is unchanged.

Three new characterization suites cover transcript redaction/reset recovery,
embedded success and fallback, fail-closed denied access, recovered-session
orchestration, reflection-file/daily-log writes, store handoff, derived cache
update, and cleanup. The focused set passed 18/18. The first evidence-write
Linux source gate passed 403 total / 401 passed / 0 failed / two platform
skips, typecheck, build, vector repair, 124/124 deterministic recall, the
200,000-row FTS baseline, official-registry vulnerabilities 0, a 42-component
SBOM, a 192-file package scan, and all three packed smokes. Documentation-bound
candidate `ac5e18b9c28e1696b95846d1b1b98fa8b1c94e4b` repeated the same
complete evidence-write gate. Its release-input identity is
`2f48eb41e55c8dc947ef8f2ed800cb83cb274cb35c6bab7ed8972ae375a59538`
across 578 tracked inputs; runtime identity remains
`0931f45e39dcbaf6a2497e5ec6ebc4bc5096b5ef302626099fd439dc24d8b821`.
Evidence commit `7897a39c0f33325259fa53adde1ba71346f868a1` then passed the
same complete gate in normal mode. The stable release-input and runtime
identities matched exactly, closing bundle 3.

The 332 MiB lockfile dependency tree and two ClawLore Jiti test-cache files
were removed. No ClawLore-named path remains in the readable `/tmp` scan. The
workspace hygiene audit still reports 86 out-of-project historical config,
session, and plugin-cache items; they were not created by this bundle and were
left intact. The live Gateway remained `active/running` with a live health
response.

No extension was deployed, live configuration or data changed, Gateway
restarted, Windows client contacted, repository pushed, tag created, or release
performed. Overall status remains NO-GO: capture/Markdown/runtime/hook
extraction, CLI/tools/storage convergence, the exact Windows gate, owned
Windows audit-root cleanup, and independent review remain open. See
`eval/clawlore-v1-brand-architecture-refactoring-bundle3-run-2026-07-17.md`.

## R2 brand and architecture bundle 4

Code commit `95047a731a80e28b4ce60e47ec72f763d93784c7` extracts two
auto-capture boundaries:

- `auto-capture-policy.ts` owns compatibility regex signals, exclusions,
  safety preflight, and category mapping while `index.ts` preserves the public
  exports;
- `auto-capture-session-state.ts` owns ingress/session-key alignment, normalized
  message selection, pending ingress, history cursors, explicit-remember carry,
  and bounded state without access, model, scope, or persistence authority.

`index.ts` retains runtime access/scope resolution, rate and value policy,
compression, smart extraction, regex persistence, Markdown dual-write, and hook
registration. It shrinks from 3,336 to 3,105 lines. Both new modules are below
800 lines, all production modules remain classified, and the 45-edge
reverse-dependency ledger is unchanged.

The extracted cursor also closes a correctness defect: a repeated agent-end
delivery with an unchanged normalized snapshot now selects zero new texts
instead of selecting the full history again. Growth still selects only its
suffix; shorter reset snapshots remain new input.

Focused tests passed 15/15. Stable plan candidate
`ea82afe9dd9bef3c99c21238df47133a5f777858` passed the complete
evidence-write Linux source gate: 411 total / 409 passed / 0 failed / two
platform skips, typecheck, build, vector repair, 124/124 recall, 200,000-row
FTS, three packed smokes, official-registry vulnerabilities 0, a 42-component
SBOM, and a 194-file package scan. Release-input identity is
`3cbe4c38c7dc132dd8ade2195358d3baa9ea9bb7c0dd60e0e08967ebf339fc02`
across 584 tracked inputs; runtime identity is
`e25fbe07227cd148da6ba1e28d90402a0646fd48be027d5f4fe4a56f56271df8`.
Evidence commit `8ad01595db43c9404bde267eff9d1caf9db6bc08` then passed the
same complete gate in normal mode. The stable release-input and runtime
identities matched exactly, closing bundle 4.

The 332 MiB lockfile dependency tree was removed and no ClawLore-named path
remained in the readable `/tmp` scan. The workspace hygiene audit still reports
86 out-of-project historical config, session, and plugin-cache items; they were
not created by this bundle and were left intact. The live Gateway remained
`active/running` with a live health response.

No extension was deployed, live configuration or data changed, Gateway
restarted, Windows client contacted, repository pushed, tag created, or release
performed. Overall status remains NO-GO: Markdown/runtime/hook extraction,
CLI/tools/storage convergence, the exact Windows gate, owned Windows audit-root
cleanup, and independent review remain open. See
`eval/clawlore-v1-brand-architecture-refactoring-bundle4-run-2026-07-17.md`.

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

1. Extract auto-capture policy and conversation-state handling from `index.ts`
   under characterization tests; do not combine it with Markdown retrieval,
   runtime construction, storage convergence, or a live rollout.
2. At the next release-candidate boundary, run the exact candidate through the
   Windows Node 24 source gate, then remove and verify absence of only the
   clearly owned audit roots.
3. Obtain independent review before repository publication. If accepted,
   create or rename the GitHub repository to `clawlore`, verify the destination,
   then update `origin` and push the audited commit.
4. Treat any live identity migration as a separate backup-backed rollout with
   an atomic config/extension switch, post-restart gates, and rollback evidence.
