# ClawLore v1 seventeenth independent-audit remediation run

Date: 2026-07-20 (Asia/Shanghai)

Status: the seventeenth review's executable source findings are remediated and
validated on Linux and Windows; publication and live rollout remain **NO-GO**.

## Scope and frozen identity

- Candidate: `/home/a/openclaw-tianji/home/state/workspace/projects/clawlore`
- Branch: `feature/clawlore-identity`
- Baseline HEAD: `33d164c4047da630341d26198461c4d3da2ba74e`
- Description: `v1.0.21-200-g33d164c-dirty`
- Declared repository: `github.com/410979729/clawlore`
- Configured origin: `github.com/410979729/scope-recall-openclaw`
- Candidate archive used by the Windows run:
  `9ab9f6e740601a50b92ba810adca75d9b7b166a50bc56165ca88ac31d3c59783`

The archive digest was recomputed after transfer and matched on both machines.
This round changed only the source candidate, tracked build output, tests, and
project evidence. It did not deploy, write the live SQL/Lance data plane,
restart the Gateway, change configuration, or mutate a repository remote.

Joy explicitly deferred the SATA/SSD hardware issue until a hardware upgrade.
No storage diagnosis, repair, backup mutation, or hardware action was attempted
in this round, and the deferred hardware item is not counted as unfinished
plugin remediation here.

## Red counterexamples before repair

The independent counterexamples were promoted into formal tests before the
implementation was accepted:

1. namespaced YAML/JSON assignments such as `DB_PASSWORD:` and
   `SERVICE_TOKEN:` escaped the common secret policy and ordinary support-bundle
   fields retained the value;
2. a lifecycle projection row could be changed to a wrong lifecycle together
   with a matching row fingerprint, while truth still represented the original
   dynamic lifecycle; health incorrectly returned ready;
3. ACL failure statements joined with `plus`, `as well as`, `以及`, or `加上`
   could be mistaken for a successful protection statement.

The lifecycle test was first strengthened to change both the projected value
and its fingerprint in one SQL statement. It reproduced the review exactly:
row-local self-consistency did not bind the projection to SQL truth.

## Source remediation

### One structured and text secret policy

`src/secret-redaction.ts` remains the single detector/redactor owner. Its
structured-assignment rule now recognizes quoted or unquoted namespace keys,
`=` or `:`, and common password/token/secret/key/cookie forms in YAML, JSON,
environment snippets, and inline objects. Capture safety, support bundles, and
task-experience transcript preparation use the same detector and redactor.
Whole placeholder values remain exempt; ordinary values do not gain an
exemption merely because a placeholder word occurs inside them.

The formal matrix includes the review's YAML/JSON examples and verifies that
an ordinary support-bundle field is redacted rather than only a preselected
diagnostic field.

### Truth-derived lifecycle health

The row-local fingerprint is retained only as a projection-row consistency
CHECK. Health no longer treats it as proof of truth binding.

Lifecycle metadata normalization was extracted into the new 150-line
`src/lifecycle-metadata.ts` domain module. It is now the shared owner for state,
source, layer, lifecycle, and timestamp normalization. This reduced
`src/smart-metadata.ts` from the temporary 814-line hotspot to 694 lines and
kept the entry within the source-governance ceiling.

`src/sql-lifecycle-projection.ts` advances the auxiliary schema to v4. During
read-only inspection it derives the expected lifecycle and validity bounds
from `memory_truth` and compares them field by field with the projection. Fast
SQL paths cover canonical rows; a deterministic normalizer is used only for
ambiguous JSON lifecycle/timestamp representations. A forged lifecycle plus a
matching row fingerprint now returns unhealthy, and the existing explicit
repair path restores the projection from truth.

The parity matrix covers confirmed/archived/rejected states, invalid source or
state, archive layer, lifecycle arrays and whitespace, numeric-string/array
timestamps, invalidation before validity, booleans, and session-summary
defaults.

### Clause and subject based ACL completion

`src/task-experience.ts` now evaluates negative clauses and their subjects
fail-closed. A denial is protective only when the denied subject remains the
unauthorized/attacker subject. A denial applying to employees, customers,
authorized users, or another legitimate subject makes the task unsuccessful,
regardless of whether the joining phrase was previously enumerated.

The formal matrix includes `plus`, `as well as`, `以及`, and `加上`, alongside
same-subject chained denials that must remain successful.

## Verification evidence

### Linux / Node 24

- Audit-focused regression bundle: 37/37 pass.
- Structure/governance/lifecycle subset: 12/12 pass.
- Full suite: 506 total, 504 pass, 0 fail, 2 platform skips.
- Strict TypeScript typecheck: pass.
- Production build: pass.
- Production dependency audit: 0 vulnerabilities.
- `git diff --check`: pass.
- Source/dist mapping after build: 229 `src` modules, 229 `dist/src`
  modules, 0 path differences; root `index.js` and `cli.js` both present.
- Final 200,000-row benchmark: known-answer recall 1, cross-scope leakage 0,
  FTS p50 0.033 ms, p95 0.061 ms, max 0.174 ms, lifecycle stats 437.267 ms,
  truth-derived health 347.033 ms, and lifecycle counts 90.231 ms.

### Windows / isolated work-computer run

The authorized work computer was used only through a new protected directory
under the current user's `AppData\Local\CodexAudits` tree. Inheritance was
removed from the owned root, and its ACL was verified to contain only the
current administrator, SYSTEM, and Administrators. The process-local TEMP/TMP
values pointed at a protected child. No global Node installation, PATH change,
service/process restart, or user-workspace modification occurred.

Official portable Node 24.14.0 was downloaded from `nodejs.org` and verified
against the official SHA-256 list. Both the download and the transferred copy
matched
`313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66`.

- Locked dependency install: pass (39 packages).
- Audit-focused secret/lifecycle/ACL subset: 30/30 pass.
- Full suite: 505 total, 497 pass, 0 fail, 8 platform skips,
  duration 282,290.7599 ms.
- Strict typecheck: pass.
- Production build: pass.
- Source/dist mapping: 229/229, 0 differences; root `index.js` and `cli.js`
  present.

Two discarded environment runs are recorded rather than hidden. The first
used the default Windows TEMP ancestry and correctly failed the product's
ancestor-trust guard. The second process command accidentally included a
trailing space in `TEMP`; 495 tests passed and two Git fixture tests rejected
the invalid path. Those two tests passed immediately with the corrected
process environment, after which the complete 497/0 full run above passed.
No production ACL or path validation was weakened.

## Release gate and remaining boundary

The source release gate still stops at the intended repository-identity check:

```text
release gate failed: package repository and origin disagree
(package=github.com/410979729/clawlore,
origin=github.com/410979729/scope-recall-openclaw)
```

The candidate is also still a dirty worktree based on the old HEAD. Therefore
this is source-remediation acceptance, not a publishable release identity.
Publication still requires an owner decision to create the canonical private
repository or rename the legacy one, update `origin`, form one clean commit
whose version/build identity uniquely names its bytes, publish an exact branch
or tag, regenerate evidence, and obtain a fresh independent review of that
exact ref.

Live recall/V2/Experience observations from the seventeenth report were not
changed by this source-only round and do not authorize cutover. The one
low-confidence live secret candidate was not inspected or mutated because that
would require a separately scoped, non-echoing live-data review.

## Cleanup

The work-computer isolation root, portable Node, dependencies, source copy,
full logs, and the malformed trailing-space TEMP child created during the
discarded environment run were all removed. Long-path deletion was used only
for that exact owned child. The owned root was then removed and independently
verified absent. The local transfer directory under `/tmp` was also removed
and verified absent.

Formal source, tests, rebuilt `dist`, this report, TODO, handoff, and daily
summary are retained as project deliverables. No user-owned or provenance-
unknown file on the work computer was changed or deleted.

The closing state-hygiene audit reported the same 95 known, overlapping
outside-workspace categories recorded earlier today: 46 backup-like residues,
4 foreign canonical documents, 5 root backups, and 40 session backups. They
are unrelated state/session/plugin artifacts and were left untouched; no new
task-specific temp root remains.
