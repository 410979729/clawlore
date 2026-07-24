# ClawLore v1 project handoff

## 2026-07-23 V2 runtime authority source candidate

The clean isolated candidate is now version 1.2.3. It adds the previously
missing production-shaped V2 transition: a receipt-gated native OpenClaw
ContextEngine, a store-only V1-to-V2 runtime mirror with V1 compensation on
failure, and a read-only cutover/V1-retirement preflight. OpenClaw uses one
string for both ContextEngine plugin loading and engine resolution, so the
adapter registers the canonical engine id `clawlore`; the earlier
`clawlore-v2` draft id was rejected during host-contract review.

`v2-write` and `cutover` require `agentToolProfile: "v2-write"`, automatic
capture/smart extraction/reflection disabled, and the mode-specific exact
readiness receipt. The profile exposes `memory_store` but deliberately omits
legacy update/forget writers. A successful store mirrors V2 truth and every
local projection in one transaction; a failed mirror compensates the V1 row.
Cutover selects V2 recall through `plugins.slots.contextEngine: "clawlore"`.
V1 remains dual-written only for the rollback window and leaves the normal
runtime after a fresh preflight reports `v1RetirementReady: true`.

Validation before the final release gate: Node 24.15.0 typecheck/build pass;
649 tests report 647 pass, 0 fail, and 2 platform skips; the packed 1.2.3
inventory contains 303 files including the cutover CLI and all new runtime
modules. The detailed run is
`docs/clawlore/eval/clawlore-v2-runtime-authority-completion-run-2026-07-23.md`.

This is source engineering completion, not a live cutover claim. Live data,
configuration, service restart, external Tag/Release publication, and V1
retirement were not changed by this source task.

Current through Phase 9, H1-H5 production hardening, the R1 canonical identity
transition, R2 brand/architecture bundle 5, the 2026-07-19 live rollout, and
the eleventh through eighteenth independent audit source-remediation rounds.

## 2026-07-19 live timeline and eleventh-audit remediation

### 11:14 guarded attempt: refused before mutation

Joy authorized rollout of exact source commit
`33d164c4047da630341d26198461c4d3da2ba74e`. The staged source,
readiness, package, and backup controls passed, but the deployment did not
occur. `clawlore-live-rollout-20260719-resume.service` exhausted its bounded
900-second idle wait because each Gateway task probe returned unknown
(`active_tasks=-1`), then terminated at 11:14:24 CST with exit status 3.
The exact cause is reproducible: the transient system unit had no `User=` and
therefore ran as root; under that identity OpenClaw blocks the user-owned live
ClawLore plugin path, rejects config validation, and makes
`gateway call status` exit 1. The same command returns a valid integer task
count under the instance identity. There was no automatic retry.

The refusal occurred before the script's Gateway stop and extension-swap
boundary. No deployment receipt, rollback directory, or failed-candidate
directory was created. The live Gateway remained the same process started at
2026-07-18 23:28:01 CST, with `NRestarts=0`, active/running state, and HTTP 200
from `/healthz`. The current config SHA-256 is identical to the freshly
captured `backup/openclaw.json.before`, so the later Brave configuration was
preserved.

The old live plugin is independently verified intact: a relative content
manifest over all 5,897 files exactly matches
`backup/clawlore-live-before.tgz`; candidate provenance and
`dist/src/cli/auth-config-transaction.js` are absent from live; and runtime
inspection reports `clawlore@1.2.0` enabled, activated, and loaded from
`/home/a/openclaw-tianji/home/state/extensions/clawlore/dist/index.js`.
Read-only doctor returned `ok=true`, with SQL truth, FTS truth/rows, and vector
rows all 1,061 and zero missing or stale FTS/vector rows.

The exact refusal audit/staging archive is
`/home/a/openclaw-tianji/home/state/workspace/archive/clawlore-live-rollout-20260719_104516-resume`.
It and the old live backup remain rollback/audit assets. The failed unit must
not be replayed automatically.

Cleanup at the refusal boundary remained failure-safe: the archive, old live
backup, staged candidate, and untracked
`dist/clawlore-build-provenance.json` were preserved. After the 14:40 rollout,
the latter was proved byte-identical to the live provenance and removed only
from the remediated source tree so it cannot mislabel a future package; the
live copy and rollout archives remain. The state hygiene audit reported 93
unrelated existing category hits:
45 backup-like residue, 4 foreign canonical documents, 5 root backups, and 39
session backups (overlapping categories). None was deleted.

### 14:40 later rollout: baseline `33d164c` deployed

A separate later rollout did deploy the same baseline commit. Current live
evidence, rechecked at 16:40 CST, is Gateway `active/running` since 14:40:35,
MainPID 276689, `NRestarts=0`, and HTTP live from `/healthz`. Runtime logs at
14:40:47 and 14:40:59 record `status=registered`, mode `shadow`, exactly one
hook, writes false, prompt mutation false, ContextEngine false, and no blocking
reasons. Runtime inspection reports `clawlore@1.2.0` enabled, activated, and
loaded from the canonical live extension. The baseline doctor remains
`ok=true`, with 1,061 SQL truth/FTS rows and zero missing/stale FTS rows.

The live build provenance names source commit `33d164c…`, but that commit id no
longer identifies the current working candidate by itself: the repository now
contains uncommitted audit remediations and a rebuilt `dist`. The remediated
source `dist/index.js` SHA-256 is `a678170c…`; live remains `95b1da2b…`.
Therefore the fixes below are not deployed.

### Eleventh independent audit: source fixes completed, live unchanged

The independent report's three release blockers were reproduced rather than
accepted on assertion alone:

- Auto-recall now aliases asymmetric hook payloads to one stable turn, never
  embeds assembled prompts, claims a turn only once, bounds abandoned turn
  state, and stores digest/length query evidence by default.
- Doctor now evaluates runtime accessibility for an explicit principal and
  reports legacy scope migration debt. Principal isolation stays secure by
  default; 1,060 `agent:main` rows are not silently exposed.
- Runtime registration now persists a private diagnostic receipt. Doctor and
  release gate require the same shadow truth: ready and unexpired binding,
  registered status, one `message_received` hook, writes/prompt mutation/
  ContextEngine false, and no blocking reasons. Readiness generation requires
  the final configured absolute output path before hashing.

The three should-fix items in the same round are also closed in source. Shared
TTL/LRU/hard-cap state bounds reflection and abandoned session maps; Experience
completion parsing no longer treats a protective `cannot/不能` sentence as task
failure; and public schema/docs/doctor now state that `autoBackup` is a
deprecated no-op instead of promising plaintext backups. Repository publication
now fails unless package metadata matches `origin` and the canonical remote
HEAD is reachable.

Validation on the rebuilt source: 467 total tests, 465 pass, 0 fail, 2 platform
skips; strict typecheck and build pass; vector-repair smoke passes; commercial
golden is 124/124 with zero scope leakage; 200,000-row FTS known-answer recall
is 1 with p95 0.069 ms; installed-package runtime and LanceDB smokes pass.

Full release acceptance is intentionally blocked. Package metadata names
`github.com/410979729/clawlore`, that repository is not currently reachable,
and local `origin` still names `scope-recall-openclaw`. The source gate now
stops at this mismatch. A clean source+dist commit, canonical evidence,
Windows gate, review, and version/tag decision remain outstanding.

No live config, extension, database, or service was changed during this audit
remediation. The current config validates under the installed OpenClaw with
Node 24.15; the earlier claim that `thinkingDefault: "ultra"` was invalid is
obsolete. A future remediated rollout still needs fresh authorization,
`autoBackup:false`, an explicit exact-principal legacy allowlist or a
backup/receipt-bound migration, a newly bound readiness receipt at the final
configured path, a user-owned rollout unit, and post-restart principal-aware
doctor plus real Telegram recall.

### Twelfth independent review: source fixes completed, live unchanged

The twelfth report found three new blockers in the uncommitted eleventh-round
candidate. All three were reproduced and closed in source:

- Auto-recall no longer maps a long-lived principal scope as a turn alias.
  Exact run/message identities bind one turn; session/conversation pending
  queues are bounded and consumed once. Interleaved id-less turns that cannot
  be safely correlated now skip recall instead of crossing, and `session_end`
  only clears exact/session aliases.
- The runtime diagnostic is now a renewable short lease rather than a static
  file. It binds a random instance id to PID plus OS process-start identity,
  refreshes every 10 seconds, expires after 30 seconds, rejects dead/PID-reused/
  unverifiable processes, and is invalidated immediately on plugin stop.
- A successful task episode is no longer automatic Experience promotion
  authority. Promotion requires `promotion_eligible=true`, reviewer approval,
  and explicit review provenance. Reviewer decline, low confidence, parse
  failure, and capture-safety skips remain non-promotable end to end.

The four should-fix findings are also closed. Completion parsing recognizes
verified ACL/security success statements without hiding real access failures.
Runtime accessibility uses canonical lifecycle classification: archived and
other inactive rows are reported separately, while visible rows and migration
debt count recallable rows only. The operator runbook and gate now accept an
explicit trusted `--principal`, give directed missing/mismatch errors, and
require local `HEAD` to equal a selected remote branch/tag via `--release-ref`.
Wildcard principals are rejected in every principal segment.

Final source verification after the last changes: 482 tests / 480 pass / 0
fail / 2 platform skips; strict typecheck and build pass; vector repair smoke
passes; commercial golden recall is 124/124 with no scope leakage; the
200,000-row FTS benchmark has known-answer recall 1, p95 0.047 ms, and no
leakage; the final npm pack contains 244 files; installed-package runtime and
LanceDB store/reopen/recall/delete/repair smokes pass. Source release gate
correctly stops at the existing package/origin identity mismatch before making
any release claim.

The rebuilt source `dist/index.js` SHA-256 is `8226bfa4…`; live remains
`95b1da2b…`, proving these changes are not deployed. The working tree currently
has 49 tracked modified and 20 untracked paths because the eleventh and twelfth
remediations plus tracked build output have not been committed. No remote,
live extension/config/database/service, tag, or release was changed.

The next safe boundary is a clean source+dist candidate, exact remote ref,
fresh independent review, and then a separately authorized backup-backed live
rollout with the intended principal and new runtime lease checked by doctor.

### Thirteenth independent review: source fixes completed, live unchanged

The thirteenth review verified that the twelfth round's original three blockers
were closed, then found one new blocker and four release-hardening gaps. The
new blocker is closed: when id-less concurrent ingress A/B is ambiguous, the
weak pending queue is detached after the safe skip, so a later ordinary turn C
recovers immediately. Exact run/message aliases are retained for late exact
correlation, and raw messages are not logged.

The runtime diagnostic service now survives `start -> stop -> start` by leasing
from immutable healthy composition truth, with heartbeat generation fencing.
Experience completion parsing distinguishes protective unauthorized-user
denials from a later authorized-user failure. Pre-gate episodes remain
explicitly counted `legacy_episode_historical` records; they are not silently
approved, and this release does not invent a weak operator override without a
separate actor/reason/evidence receipt.

Secret detection and redaction are now one domain policy shared by capture,
support bundles, and Experience transcript preparation. The policy covers the
previous rules plus common Stripe, GitLab, Google OAuth, SendGrid, Twilio, AWS
temporary key, broader GitHub/Slack/JWT, PuTTY, and alphanumeric password forms.

Lifecycle diagnostics no longer pull every metadata JSON value into
JavaScript. A rebuildable auxiliary SQLite projection is updated with truth
transactions and aggregated in SQL. The 200,000-row lifecycle measurement fell
from the audit's roughly one second to 90.839 ms; the new 1,000,000-row gate is
487.000 ms. Both retain known-answer recall 1 and zero cross-scope leakage.

V2 transaction handling now preserves the original error if rollback itself
fails, checks compatibility-backfill prerequisites before append apply, and
validates convergence/integrity/foreign keys before initial rollout commit. A
post-commit failure emits `CLAWLORE_V2_POST_COMMIT_RECOVERY_REQUIRED` and
requires verified encrypted-snapshot restoration to a new location; it does
not claim an unsafe in-place automatic rollback.

The remaining accepted static hardening is also closed. Empty episode scopes
fail closed; shared-scope episode visibility is symmetric; playbook FTS pushes
scope/status/task filters ahead of rank/limit; and fail-open manual-memory
duplicate checks persist `dedup_skipped=true` when their vector precheck is
unavailable.

Final Linux verification: 491 total / 489 pass / 0 fail / 2 Windows-only
skips; strict typecheck/build, vector repair, 124/124 golden, 200K and 1M scale
gates, 246-file pack, installed-package runtime/LanceDB smokes, and isolated
real OpenClaw load/doctor/three-command smokes all pass. Candidate
`dist/index.js` is still `8226bfa4...`; live remains `95b1da2b...`.

Release remains NO-GO. The worktree has 72 tracked modified and 25 untracked
paths, `origin` still points at `scope-recall-openclaw`, the exact Windows Node
24 gate and clean-candidate independent review remain open, and no commit,
push, tag, release, configuration, database, service, or live extension was
changed. Detailed evidence:
`eval/clawlore-v1-thirteenth-independent-audit-remediation-run-2026-07-19.md`.

### Fourteenth independent review: source fixes completed, live unchanged

The review's two blockers and three should-fix findings were independently
reproduced and accepted. Secret matching now scans every hit in a pattern and
only exempts an exact placeholder token, so an earlier fixture cannot hide a
later credential and ordinary values containing placeholder words remain
sensitive.

All current direct `memory_truth` governance mutations now synchronize the
lifecycle projection in the same SQLite transaction: candidate promotion,
forgetting archive/delete, cleanup/rollback, legacy hygiene migration, and the
standard truth store. Fault injection proves truth, projection, and audit state
roll back together. A source gate rejects new raw DML owners outside the exact
allowlist. Health checks compare schema, row count, state count, scope, and
truth update revision rather than treating equal counts as freshness.

Projection table, state, and index recover as one versioned auxiliary schema.
Doctor and stats are read-only on drift and return an explicit issue instead of
silently rebuilding or returning stale lifecycle counts. Ordinary reopen of an
established authority also never initializes or repairs that auxiliary state;
fresh authority creation and the receipt-backed legacy upgrade are the only
startup-time initialization boundaries. The new
`repair-lifecycle-projection` operator command previews by default and rebuilds
only with `--apply`. ACL text fallback also handles authorized-subject switches
after conjunctions in English and Chinese.

Final Linux verification: 498 total / 496 pass / 0 fail / 2 Windows-only
skips; 28/28 post-document governance tests; typecheck/build/vector repair;
golden 124/124; 200K FTS p95 0.055 ms and complete lifecycle diagnostics
211.412 ms; 1M FTS p95 0.073 ms and complete lifecycle diagnostics 1,077.821
ms under an explicit 1,500 ms million-row ceiling; 246-file pack; installed
runtime/LanceDB; isolated real OpenClaw inspect/doctor/no-write drift preview/
apply-repair/three-command smokes. The scale numbers now include freshness
inspection as well as aggregation; the default 500 ms ceiling remains the 200K
gate. An unqualified 1M probe failed that 500 ms ceiling at 1,121.687 ms before
the declared 1,500 ms million-row gate passed; do not report the former as a
product regression or conceal it as a successful default run.

Release remains NO-GO. Repository identity still blocks the source gate,
Windows Node 24 and a new clean-commit independent review remain open, and the
candidate (83 tracked dirty plus 26 untracked paths) is not committed, pushed,
tagged, released, or deployed. Candidate
runtime digest is `09949335...`; live is `25b0979c...`. Detailed evidence:
`eval/clawlore-v1-fourteenth-independent-audit-remediation-run-2026-07-19.md`.

### Sixteenth independent review: source fixes and Windows rerun completed, live unchanged

The sixteenth report was correct that the formal candidate had not advanced,
that release identity was still unresolved, and that live storage/backup state
made deployment unsafe. Its executable code findings were reproduced from the
same frozen source before repair. Five red assertions covered three root
causes: env-style credentials and credential-bearing HTTP headers escaped the
shared secret policy; lifecycle health accepted a same-revision mutation of a
derived projection field; and task-completion parsing treated an unknown
legitimate ACL subject as if it were still the unauthorized subject.

The source remediation keeps one owner per rule. `secret-redaction.ts` now
covers env credentials, Basic/Proxy authorization, and cookie headers for all
capture, support-bundle, and Experience transcript consumers. Lifecycle
projection schema v2 stores a CHECK-bound fingerprint of its derived fields;
read-only inspection reports `row_projection_mismatch`, while the existing
explicit repair authority remains the only rebuild path. ACL completion
parsing now detects a substantive post-denial subject phrase without a finite
noun allowlist and preserves same-subject chained denials.

Linux verification passed 43/43 focused assertions, 11/11 architecture/source
governance assertions, 14/14 lifecycle/governance assertions, and 502 total /
500 pass / 0 fail / 2 platform skips. Strict typecheck and build passed. The
200,000-row benchmark retained known-answer recall 1 and cross-scope leakage 0,
with FTS p95 0.049 ms and complete lifecycle diagnostics 351.386 ms under the
500 ms gate.

The prior Windows red gate was traced to its audit fixture, not bypassed in
production code: the NAS/system temp ancestry was writable by a broad
principal and correctly triggered `CLAWLORE_WINDOWS_ACL_ANCESTOR_UNTRUSTED`.
On the authorized work computer, a new protected directory under the current
user profile reproduced the workflow's trusted TEMP/TMP boundary. Official
portable Node 24.15.0 was SHA-256 verified; the frozen audit snapshot was
copied locally on that computer; and a target-local patch changed nine files.
Their SHA-256 values matched the Linux candidate exactly. `npm ci` completed,
focused tests passed 33/33, the full Windows suite passed 493 with 0 failures
and 8 platform skips out of 501, and Windows typecheck/build passed. The
isolated directory contained only `repo`, `temp`, and `tools`; it was removed
after verification and confirmed absent. The original audit evidence was not
modified.

This is still not release acceptance. `package.json` declares
`github.com/410979729/clawlore`, while `origin` remains
`github.com/410979729/scope-recall-openclaw`; the canonical repository is not
reachable. The source gate therefore exits at repository identity before any
release claim. A clean commit, exact remote branch/tag, regenerated evidence,
and a fresh independent review remain required. Storage errors and the
off-machine encrypted backup/restore gap separately keep live deployment and
bulk database mutation blocked. No live extension, configuration, database,
Gateway, service, remote, commit, tag, or release changed in this round.
Detailed evidence:
`eval/clawlore-v1-sixteenth-independent-audit-remediation-run-2026-07-20.md`.
The closing state-hygiene audit still reports 95 unrelated outside-workspace
category hits; the owned Linux and Windows test roots are absent, and those
pre-existing state/session/plugin artifacts were not deleted in this task.

### Seventeenth independent review: mechanism fixes and cross-platform rerun completed

The seventeenth review correctly showed that the sixteenth-round changes only
covered selected examples. Its executable counterexamples were promoted into
formal tests before the implementation was accepted. Namespaced YAML/JSON
credential assignments escaped ordinary support-bundle fields; a wrong
lifecycle plus a matching row fingerprint remained self-consistent but
contradicted truth; and ACL failures joined with previously unlisted phrases
could still look successful.

The secret detector/redactor remains one shared policy and now handles quoted
or unquoted namespace keys with `=` or `:` across capture, support bundles, and
task-experience transcripts. Lifecycle health no longer trusts a projection
digest as proof of truth binding. Schema v4 derives the expected lifecycle and
validity bounds from `memory_truth` and compares them with the projection. The
canonical normalization rules moved into the 150-line
`lifecycle-metadata.ts`; `smart-metadata.ts` fell from the temporary 814-line
hotspot to 694 lines. ACL completion now classifies negative clauses and their
subjects fail-closed instead of enumerating connectors.

Final Linux verification passed 37/37 audit-focused assertions, 12/12
structure/governance assertions, and 506 total / 504 pass / 0 fail / 2
platform skips. Typecheck, build, production dependency audit, `git diff
--check`, and 229/229 source-dist mapping passed. The final 200,000-row gate
retained recall 1 and zero leakage, with FTS p95 0.061 ms and lifecycle stats
437.267 ms.

The authorized Windows work-computer rerun used official checksum-verified
portable Node 24.14.0 and a protected process-local TEMP/TMP root. The
candidate archive digest matched across machines. Audit-focused tests passed
30/30; the full suite passed 497 with 0 failures and 8 platform skips out of
505; typecheck, build, and 229/229 source-dist mapping passed. Two discarded
environment runs were diagnosed as default TEMP ancestry and an accidental
trailing-space TEMP value; no production path guard was weakened. The owned
Windows root, including that malformed child, and the local transfer root were
removed and verified absent.

Release remains NO-GO for provenance rather than these three code findings.
The worktree is still dirty on baseline `33d164c`, package metadata names
`410979729/clawlore`, and `origin` still names the legacy repository. No live
plugin, config, database, Gateway, service, remote, commit, tag, or release was
changed. Joy explicitly deferred the SATA/SSD item until hardware upgrade, so
this round neither investigated nor acted on it. Detailed evidence:
`eval/clawlore-v1-seventeenth-independent-audit-remediation-run-2026-07-20.md`.

### Eighteenth independent review: parser-backed secrets and structured outcome gate completed

The eighteenth review confirmed that lifecycle truth binding remained closed,
but extended the other two input families beyond the seventeenth-round matrix.
Common camelCase credential keys and YAML block scalars still escaped the text
policy, and natural-language authorized-user failures could still pass the
complete Task Experience gate.

The public secret detector/redactor remains the single policy owner. A focused
`secret-structured-text.ts` domain module now parses valid YAML/JSON with exact
value ranges and normalizes snake, kebab, dotted, namespaced, camelCase, and
quoted key forms before policy evaluation. Embedded malformed fragments use a
bounded fallback with the same key classifier. Redaction removes the complete
quoted, multi-word, or block-scalar value while keeping serializer shape
legible. Capture safety, support bundles, and Experience transcripts all use
the same path. `passwordPolicy` and `tokenCount` remain explicit negative
cases.

Task outcome moved into the focused `task-outcome-evidence.ts` domain module.
The production hook passes the real `agent_end` event, and the capture gate now
requires its explicit success bit, a terminal successful structured tool
result, and a final completion-plus-verification claim. Free-form stdout is
not success evidence. Clause/subject classification remains defense in depth,
so employee/customer/ordinary-staff capability failures reject the full gate
even when the rest of the transcript looks successful. `task-experience.ts`
fell from 735 to 679 lines.

Linux verification passed 36/36 audit-focused assertions, 8/8
structure/security assertions, and 511 total / 509 pass / 0 fail / 2 platform
skips. Typecheck, build, `git diff --check`, production audit, 233/233
source-dist mapping, pack dry-run, and the 200,000-row benchmark passed. The
final benchmark retained recall 1 and zero leakage, with FTS p95 0.050 ms and
lifecycle stats 439.119 ms.

The authorized Windows work-computer run used checksum-verified portable Node
24.14.0, protected process-local TEMP/TMP/cache paths, and the same source
inputs (cross-machine manifest digest matched). The full suite passed 502 with
0 failures and 8 platform skips out of 510; typecheck and build passed. The
owned Windows audit root and local comparison/transfer roots were removed, and
the Windows root was independently verified absent.

Release remains NO-GO. The worktree is dirty on baseline `33d164c`, package
metadata names `410979729/clawlore`, and `origin` still names the legacy
repository; the source release gate stops at that mismatch. Live recall scope
alignment, Experience effectiveness, V2/data convergence, and the
low-confidence secret-pattern review were not changed or authorized. No live
plugin, config, DB/vector, Gateway, service, remote, commit, tag, or release was
mutated. Detailed evidence:
`eval/clawlore-v1-eighteenth-independent-audit-remediation-run-2026-07-20.md`.

### Nineteenth self-audit: complete pre-push candidate gate passed, provenance still external

A fresh call-site and boundary audit did not stop at the two eighteenth-round
counterexamples. It traced every durable input, merge, metadata, provider
output, export, CLI/support response, reflection/digest path, legacy path, and
V2 Truth/Experience write. Explicit focused modules now own final admission,
metadata, egress, merge, provider-output, and V2 persistence policy. Structured
task failures are terminal unless the transcript proves repair and final
verification. Runtime recall/capture state is bounded and exactly owned;
private files, locks, SQLite sidecars, migration markers, shadow traces,
reflection state, and self-improvement state share owner-only atomic and
symlink-safe boundaries.

Architecture governance was tightened at the same time. Independent
responsibilities were extracted rather than appended to hotspots;
reverse-dependency debt is 29; `src/store.ts` remains at 2,008 lines under its
2,010-line non-growth ceiling; and the source/dist release mapping is 244/244.
The candidate version is 1.2.1.

The final compatibility audit found that Node 24.14 was still accepted even
though the installed OpenClaw 2026.7.1-2 host requires Node 24.15 or newer on
the Node 24 line. Package/lock engines, CI, the reusable workflow, release
contract, tests, and changelog now require `>=24.15.0 <25`.

Linux Node 24.15 passed 570 total / 568 pass / 0 fail / 2 skips, typecheck,
build, 244/244 mapping, 0 production vulnerabilities, a 260-file pack, recall
1, and zero cross-scope leakage. The exact candidate then passed the complete
pre-push gate from an isolated clean Git checkout whose non-network origin
matched the canonical package identity, including tarball install, packed
runtime/LanceDB/real OpenClaw/legacy migration smokes, SBOM, and benchmarks.

The authorized Windows work-computer run used checksum-verified official
portable Node 24.15 in an owner-only isolated root and did not alter global
Node or the work environment. The complete pre-push gate passed: 569 total /
552 pass / 0 fail / 17 platform skips, typecheck/build, all packed smokes, 0
production vulnerabilities, 260 package files, recall 1, and zero scope
leakage. Release-input, runtime, and lock identities matched Linux exactly.
There were no residual audit-root Node processes. The Windows root and local
transfer root were removed and independently verified absent.

The complete source+tracked-dist candidate is now local commit
`977e20375fec7cbc6be76b566c12d1ca0ffb5d77` on
`feature/clawlore-identity`; the worktree was clean immediately afterward.
The real remote is not yet publishable. Package metadata names
`410979729/clawlore`; actual `origin` still names
`410979729/scope-recall-openclaw`; and the canonical repository is not
reachable. The real gate rejects this as designed. Joy must choose repository
creation versus rename, after which the exact sequence is: update origin, run
real pre-push on the clean branch containing `977e203`, push the exact branch,
run strict post-push evidence, and obtain a fresh independent review before
tag/release.

Live recall/Experience effectiveness, V2/data governance, and the
low-confidence live secret candidate remain separate operational work. No
live plugin, config, database/vector, Gateway, service, remote, push, tag,
release, work environment, or deferred SATA/SSD state was changed.
The final workspace hygiene audit reports 105 overlapping out-of-workspace
state/session/third-party residues; no task-owned Linux or Windows test root
remains. Detailed evidence:
`eval/clawlore-v1-nineteenth-self-audit-remediation-run-2026-07-20.md`.

## Authenticated live identity rollout preflight

Joy authorized replacing the legacy live memory plugin with the canonical
ClawLore candidate in an authenticated Telegram direct conversation. Fresh
clean-source Linux and reproducibility gates passed on exact candidate
`c6bfb29`; a private copy of all 1,036 live truth rows migrated to schema
version 4 and reopened under strict authority checks; and an isolated state
root proved the required artifact-first, atomic-config staging sequence.

The rollout did not proceed. The authorized Windows work computer was offline,
so the mandatory exact Windows Node 24 gate and owned audit-root cleanup could
not run; independent source review also remains open. The live Gateway stayed
healthy on `scope-recall-openclaw@1.1.0`, with no extension/config/database or
restart mutation. Full evidence and continuation criteria are in
`eval/clawlore-v1-live-identity-rollout-preflight-2026-07-17.md`.

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

Evidence commit `22f2887` then repeated the complete source gate in normal
mode. The same 418/416/0/2 test result, all three packed smokes, 239-file scan,
zero-vulnerability audit, release-input identity `6f7edcc2…`, and runtime
identity `40d82723…` passed stable evidence comparison. The source is therefore
ready to hand to an independent auditor.

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

Baseline commit `33d164c4047da630341d26198461c4d3da2ba74e` is the deployed
ClawLore 1.2.0 runtime. It became live at 14:40:35 CST on 2026-07-19. The
eleventh-audit source fixes described above have not been deployed.

Live behavior is V1 fallback plus ClawLore read-only shadow. Telegram is
sender-allowlisted, every configured group plus the wildcard group denies the
declared memory/governance tool surface, the service uses `UMask=0077`, and
SQLite/WAL/SHM are `0600`. Runtime model credentials are SecretRefs. V2 writes,
lifecycle promotion, ContextEngine, prompt mutation, and final recall remain
disabled. Baseline doctor is storage-healthy, but it predates the new runtime
receipt and principal-accessibility doctor contract; `ok=true` must not be read
as clearance for the remediated release.

The H5 report is
`eval/clawlore-v1-h5-production-deployment-run-2026-07-14.md`.

## Why cutover remains closed

Phase 9 and H5 both found real production debt: no active/injectable/eligible
V2 memories, unresolved verification/principal debt, unapplied archive
proposals, current V1/V2 content differences, and no separately authorized
runtime cutover implementation. `no_cutover` is a completed safety decision,
not an implied approval to switch later without fresh evidence.

## Next controlled boundary

1. Create or rename the GitHub repository to `clawlore`, verify it is reachable,
   then update `origin`; do not weaken the repository-identity gate.
2. Commit source and tracked `dist` as one candidate, regenerate canonical
   release evidence, and run the exact Windows Node 24 plus independent-review
   gates before version/tag publication.
3. Make an explicit operator decision for the 1,060 legacy `agent:main` rows:
   exact current-principal allowlist for bounded compatibility, or a private
   backup/receipt-bound scope migration. Do not disable principal isolation.
4. Treat deployment of the remediated candidate as a new backup-backed rollout:
   set deprecated `autoBackup` false, generate readiness at the final pointer,
   run probes under `User=a`/`Group=a`, atomically swap, restart once, and require
   principal-aware doctor, runtime receipt, health/auth/search, and real Telegram
   recall before acceptance.

## 2026-07-22 independent memory-quality audit and 1.2.2 remediation

The deployment-ready conclusion for 1.2.1 is withdrawn. Manual recall was
silently reinforcing every returned result, the 40-question corpus had no
no-answer cases, plaintext secret-shaped material remained in multiple
persistence layers, and the enabled nightly writer still reads legacy JSONL
instead of the active OpenClaw SQLite transcript database.

The isolated 1.2.2 source candidate makes manual recall observation-only,
introduces a separately owned confidence/abstention policy, requires schema-v2
positive and negative quality metrics, extends the canonical secret policy,
and adds a content-free streaming persisted-secret audit. The new policy lives
outside the 1,425-line retriever hotspot; architecture and non-growth checks
pass without increasing the budget.

The operator 40+10 deterministic corpus is intentionally red: all ten negative
cases abstain, but nine positives are rejected and precision remains below the
release threshold. A live-provider gate is still required. The production
secret audit is also red and the current controlled verifier is not configured,
so credential rotation, exact cross-store purge, cron/config changes, deploy,
restart, and migration remain blocked. See
`eval/clawlore-v1-twentieth-memory-quality-remediation-run-2026-07-22.md`.

## 2026-07-22 P8 production-GO preflight correction

The preceding P6 quality conclusion is historical, not current clearance. P7
fixed the deterministic corpus and SQLite transcript reader; P8 has now also
passed the same reviewed 40-positive/10-no-answer corpus through the configured
live provider at Recall@3, Precision@3, MRR and abstention 1.0, with zero false
positives, scope leaks or unsafe egress. Two supporting results are explicitly
annotated as `relevant_ids`; they do not satisfy mandatory-answer Recall/MRR,
cannot appear on negative cases, and do not weaken retrieval thresholds.

P8 also corrected the OpenClaw SecretRef leaf contract and replaced the former
partial secret audit with one shared policy over canonical/history/FTS/
projection/Experience/digest/conversation and LanceDB content. The new live
read-only preflight reports 103 mirrored rows and 149 fields, with an
81-payload upper bound; these are not 103 unique memories. SQLite companions
and the full LanceDB tree now participate in the owner-only mode gate.

The source checkout now contains a digest- and identity-bound exact remediation
planner/apply path plus actually restored encrypted snapshots for memory SQL,
generic conversation SQLite, and the LanceDB companion. Apply requires the
three source-bound receipts, prior credential rotation, explicit approval, a
fresh plan digest and permission tightening. It purges affected V1/V2 truth,
history, FTS and vector rows, redacts non-memory records, handles orphan
projections without fabricating ledger events, and fails with
`CLAWLORE_PERSISTED_SECRET_REMEDIATION_RECOVERY_REQUIRED` after any external or
committed mutation boundary instead of claiming a whole-system rollback.

This closes candidate-side tooling, not the production incident. Live remains
NO-GO until a registered controlled secondary verifier passes and authorizes:
disable both bypass writers, rotate credentials, create fresh three-store
snapshots, execute a newly generated exact remediation plan, set deprecated
`autoBackup` false, deploy/restart once, and complete live-provider shadow plus
real-channel acceptance. OpenClaw transcript rows remain read-only evidence;
controlled OpenClaw auth stores are outside ClawLore's purge boundary.
