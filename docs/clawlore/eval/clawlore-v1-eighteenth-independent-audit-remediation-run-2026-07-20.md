# ClawLore v1 eighteenth independent-audit remediation run

Date: 2026-07-20 (Asia/Shanghai)

Status: the eighteenth review's two executable source findings are remediated
and validated on Linux and Windows; publication, deployment, V2 write/cutover,
and live-data governance remain **NO-GO**.

## Scope and identity boundary

- Candidate: `/home/a/openclaw-tianji/home/state/workspace/projects/clawlore`
- Branch: `feature/clawlore-identity`
- Baseline HEAD: `33d164c4047da630341d26198461c4d3da2ba74e`
- Description: `v1.0.21-200-g33d164c-dirty`
- Declared repository: `github.com/410979729/clawlore`
- Configured origin: `github.com/410979729/scope-recall-openclaw`
- Source and manifest version: `1.2.0`

This was a source-only remediation. It changed candidate source, tests,
dependency metadata, rebuilt `dist`, architecture/handoff evidence, and this
report. It did not deploy the candidate, change the live extension, write SQL
or Lance data, restart the Gateway, modify OpenClaw configuration, change a Git
remote, commit, push, tag, or publish a release.

Joy explicitly deferred the SATA/SSD hardware issue until the planned hardware
upgrade. This round did not diagnose or act on that deferred item.

## Red counterexamples before repair

The review's executable inputs were promoted into formal regressions before
the implementation was accepted:

1. JSON keys such as `databasePassword` and `serviceToken` escaped the shared
   secret detector/redactor;
2. YAML block-scalar credentials escaped detection and their complete values
   remained in ordinary support-bundle fields and task transcripts;
3. full, tool-backed Task Experience transcripts could pass the capture gate
   even when the final answer stated that employees, paying customers, or
   ordinary staff still lacked the authorized capability;
4. a tool-looking transcript without an explicit structured outcome could be
   mistaken for success if free-form output happened to look successful.

The lifecycle truth-binding counterexample from the seventeenth review stayed
green. No lifecycle mechanism change was needed in this round.

## Source remediation

### Parser-backed structured secret policy

`src/secret-redaction.ts` remains the single public detector/redactor owner.
The new focused domain helper `src/secret-structured-text.ts` parses valid
YAML/JSON with `yaml@2.9.0`, traverses mapping nodes, and returns exact source
ranges for credential values. It normalizes serializer and key-style variants
before policy evaluation:

- snake_case and upper-case environment keys;
- kebab, dotted, and namespaced keys;
- camelCase and acronym transitions;
- quoted and unquoted keys;
- `:` and `=` assignments;
- quoted multi-word values and YAML literal/folded block scalars.

Malformed or prose-embedded configuration fragments use a bounded textual
fallback, but both routes share the same normalized-key classifier. Policy
suffixes such as `password`, `token`, `secret`, `credential`, and compound key
forms remain centralized. Non-secret configuration names such as
`passwordPolicy` and `tokenCount` are formal negative cases.

Redaction uses the exact parsed value range before the legacy token-shape
patterns run. JSON quoting and YAML block shape remain syntactically legible,
while the complete credential value is removed. Capture safety, ordinary and
nested support bundles, and Task Experience transcript preparation all consume
this same owner. Tests assert both detection and the stronger postcondition
that the final output no longer contains the full synthetic value.

### Structured task outcome as the primary capture gate

Task outcome classification moved into the new 219-line pure domain module
`src/task-outcome-evidence.ts`; `src/task-experience.ts` fell from 735 to 679
lines. The runtime hook now passes the actual `agent_end` event into capture.

The capture gate requires all of the following:

1. an explicit successful `agent_end` event in the production hook;
2. enough task and tool evidence for the configured gate;
3. an explicit structured tool-result outcome (`isError`, `success`, `ok`,
   status/outcome/state, or numeric exit code), with the terminal structured
   result successful;
4. a final answer that claims both completion and verification;
5. no final-answer failure affecting an authorized or otherwise non-protective
   subject.

Free-form stdout is deliberately not elevated to structured success evidence.
Earlier tool failures may be followed by a real structured recovery, but a
missing or terminally failed result is rejected before the LLM reviewer and
before reusable-memory storage.

Clause/subject classification remains a defense-in-depth check. A denial is
protective only when it is explicitly bound to an unauthorized actor or is an
unambiguous continuation of that same subject. Natural-language forms such as
`employees still have no access`, `neither can paying customers`, and
`普通员工仍没有管理端访问权限` now fail the complete capture gate even when the
surrounding transcript has four messages, tool evidence, sufficient length,
and a successful structured tool envelope.

### Maintainability boundary

The YAML/JSON parser and task-outcome classifier are separate, focused domain
modules rather than additional branches in entry points or generic helpers.
The source-governance test and architecture module map classify both modules
and preserve one owner per rule. Entrypoint and hook files remain orchestration
layers; no database write path was added or bypassed.

## Verification evidence

### Linux / Node 24

- Audit-focused regressions: 36/36 pass.
- Structure/security/governance subset: 8/8 pass.
- Full suite: 511 total, 509 pass, 0 fail, 2 platform skips.
- Strict TypeScript typecheck: pass.
- Production build: pass.
- `git diff --check`: pass.
- Production dependency audit: 0 vulnerabilities.
- Source/dist path mapping: 233/233, 0 missing paths, including root
  `index.js` and `cli.js`.
- `npm pack --dry-run`: 249 files, 511,125-byte package,
  2,503,319 bytes unpacked; no tarball retained.
- Final 200,000-row benchmark: known-answer recall 1, cross-scope leakage 0,
  FTS p50 0.033 ms, p95 0.050 ms, max 0.225 ms, lifecycle stats
  439.119 ms, truth-derived lifecycle health 347.771 ms, and lifecycle counts
  91.344 ms.

### Windows / isolated work-computer run

The authorized work computer was used only through the owned directory
`C:\Users\Administrator\AppData\Local\CodexAudits\clawlore-audit18-remediation-20260720-224520`.
Inheritance was removed, and the root ACL was restricted to the current
administrator, SYSTEM, and Administrators. TEMP, TMP, the npm cache, portable
Node, dependencies, source copy, build output, and logs all stayed under this
root. No global Node installation, machine/user PATH, service, process, or
existing user workspace was changed.

The machine's direct `nodejs.org` download timed out without changing its
environment. The archive was instead downloaded on the source host, checked
against Node's official `SHASUMS256.txt`, and transferred into the protected
root. Portable Node 24.14.0 used the verified archive digest
`313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66`.

The cross-machine source-input manifest excluded only Git metadata,
dependencies, generated `dist`, and the Windows test log. Its deterministic
path+SHA-256 digest matched on both machines:
`6b0266eda77e6fa1e14295a939e67cc68f898151fc6644f16e19580daafab0ab`.

- Locked dependency install: pass (40 packages).
- Full suite: 510 total, 502 pass, 0 fail, 8 platform skips,
  duration 278,972.606 ms.
- Strict typecheck: pass.
- Production build: pass.

The Linux/Windows test-count difference is the existing platform skip and
discovery shape, not a hidden failure. The Windows run used the same source
inputs and ended with zero failed tests.

## Release gate and remaining NO-GO boundary

The source release gate still fails at the intended first provenance check:

```text
release gate failed: package repository and origin disagree
(package=github.com/410979729/clawlore,
origin=github.com/410979729/scope-recall-openclaw)
```

The candidate also remains a dirty worktree based on the old HEAD. Therefore
this round closes source findings; it does not create a publishable `1.2.0`
identity. Publication still requires Joy's repository decision, a correct
origin, one clean source+dist commit, an exact reachable branch/tag whose
version or build identity names one manifest, regenerated release evidence,
and a fresh independent review of that exact ref.

The eighteenth review's live evidence remains outside this source-only change:

- shadow recall has no positive candidates or overlap because observed traffic
  scopes and stored truth scopes are not aligned;
- Task Experience has no durable reusable row in the observed live window;
- V2/truth gaps and duplicate groups require read-only classification and an
  approved dry-run receipt before any governance write;
- the one low-confidence live secret-pattern candidate was not inspected or
  mutated.

No live observation above is converted into deployment or cutover permission.

## Cleanup

The exact Windows audit root was removed recursively after verification and an
independent existence probe returned `ABSENT`. This removed only the owned
portable Node, npm cache, dependency tree, candidate copy, comparison archive,
temporary directories, and test logs; it is not recoverable from that test
machine. Local transfer and manifest-comparison roots were temporary and were
removed. No task-specific `.tgz`, `.log`, `.tmp`, or Windows test artifact
remains in the project.

Formal source, tests, rebuilt `dist`, dependency lock, architecture/handoff
updates, and this report are retained as project deliverables. The closing
state-hygiene audit returned `STATE_HYGIENE_ISSUES 103`: 50 backup-like paths,
4 foreign canonical documents, 5 root backups, and 44 session backup/reset
paths. These categories overlap. Relative to the earlier 95-category receipt,
four session `.deleted` files timestamped 22:20:39 are each counted in both the
backup-like and session categories. They were generated outside the workspace
by the session layer at current-turn dispatch, not by the project test roots,
and were left untouched. No task-specific plugin or work-computer test root
remains.
