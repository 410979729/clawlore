# ClawLore v1 sixteenth independent-audit remediation run

Date: 2026-07-20 (Asia/Shanghai)

Status: source remediation and Linux/Windows validation complete; release and
live rollout remain **NO-GO**.

## Frozen baseline

- Branch: `feature/clawlore-identity`
- Baseline HEAD: `33d164c4047da630341d26198461c4d3da2ba74e`
- Baseline description: `v1.0.21-200-g33d164c-dirty`
- Declared repository: `github.com/410979729/clawlore`
- Configured origin: `github.com/410979729/scope-recall-openclaw`
- The canonical repository was not reachable at review time.
- Candidate and live artifacts were different before this round; the live
  plugin was not used as a source tree and was not modified.

## Red counterexamples before repair

A new focused regression bundle was executed before source changes. It produced
five failures:

1. env-style credentials were not detected by the capture policy;
2. the same credential forms leaked through nested support-bundle values;
3. task-experience transcript preparation retained env/header credentials;
4. lifecycle health returned ready after a same-revision derived-row mutation;
5. an unknown legitimate ACL subject such as `employees` was treated as a
   protective continuation of the unauthorized subject.

These failures were kept as regression coverage and turned green by the source
changes below.

## Source remediation

### Unified secret policy

`src/secret-redaction.ts` remains the single detector/redactor owner. It now
recognizes:

- env-style password/token/secret/key/cookie assignments;
- Basic and Proxy-Authorization headers;
- Cookie and Set-Cookie headers.

Whole placeholder values remain exempt through the existing common placeholder
rule. Capture safety, support bundles, and task-experience transcript handling
all consume this same policy.

### Lifecycle projection freshness

`src/sql-lifecycle-projection.ts` advances the auxiliary schema from v1 to v2.
Projection rows carry a `projection_fingerprint` derived from scope, static
lifecycle, validity bounds, and truth revision. A table CHECK prevents ordinary
inconsistent writes; read-only inspection independently returns
`row_projection_mismatch` when a row is changed without the bound fingerprint.
The explicit repair path rebuilds the auxiliary schema and projection; ordinary
open/stats/doctor paths remain non-mutating on drift.

### ACL completion parsing

`src/task-experience.ts` no longer relies on a finite list of legitimate subject
nouns. After a protective capability denial, it distinguishes a bare
same-subject modifier from a substantive new subject phrase. Regression cases
cover employees, paying customers, ordinary staff, 普通员工, and chained denials
for the original unauthorized subject.

## Verification evidence

### Linux / Node 24.15.0

- Focused red-to-green bundle: 43/43 pass.
- Architecture/source-governance bundle: 11/11 pass.
- Lifecycle/governance/legacy bundle: 14/14 pass.
- Full suite: 502 total, 500 pass, 0 fail, 2 platform skips.
- Strict TypeScript typecheck: pass.
- TypeScript production build: pass.
- `git diff --check`: pass.
- 200,000-row benchmark: known-answer recall 1, cross-scope leakage 0,
  FTS p50 0.035 ms, p95 0.049 ms, max 0.213 ms, lifecycle diagnostics
  351.386 ms under the 500 ms gate.

### Windows / isolated work-computer run

The earlier Windows audit fixture used a broad inherited temp ancestry. That
correctly triggered the production ancestor-trust guard and was not fixed by
weakening ACL validation.

The rerun used a new protected root under the current user profile and private
TEMP/TMP children, matching the release workflow contract. Node 24.15.0 was
downloaded from the official distribution, verified against the official
SHA-256 list, and used only from the isolated directory. No global install,
PATH change, service/process restart, or user-workspace mutation occurred.

- Nine changed source/test files matched the Linux SHA-256 values exactly.
- Locked dependency install: pass.
- Focused suite: 33/33 pass.
- Full suite: 501 total, 493 pass, 0 fail, 8 platform skips,
  duration 241,649.338 ms.
- Strict typecheck: pass.
- Production build: pass.
- The isolated root contained only `repo`, `temp`, and `tools`; it was removed
  after testing and verified absent.
- The frozen audit source/evidence directory was not modified.

## Release gate and live boundary

`node scripts/run-release-gate.mjs --source-only` intentionally exits 1 at the
first identity check:

```text
release gate failed: package repository and origin disagree
(package=github.com/410979729/clawlore,
origin=github.com/410979729/scope-recall-openclaw)
```

This is an external publication blocker, not a remaining code-test failure.
The owner must choose whether to create a new canonical repository or rename
the legacy repository, then publish a clean exact branch/tag and regenerate
release evidence. A fresh independent review must target those exact bytes.

Separately, recent SATA link/write errors and the incomplete encrypted
off-machine backup/restore chain make live deployment or bulk database mutation
unsafe. This run made no live plugin, configuration, database, Gateway,
service, repository remote, commit, tag, or release change.

## Cleanup

The work-computer isolation tree and its portable Node/dependencies/test output
were removed after verification. The local target-patch helper was temporary
and is removed during task close. Formal source, tests, rebuilt `dist`, this
evidence report, TODO, handoff, and daily summary are retained as deliverables.

The final state-hygiene audit reported 95 category hits outside `workspace/`:
46 backup-like residues, 4 foreign canonical documents, 5 root backups, and
40 session backups (overlapping categories). These are older state/session/
plugin artifacts outside this task; none was created or modified for the
remediation, and none was deleted without separate scope. The task-specific
local temp directory was independently verified absent.
