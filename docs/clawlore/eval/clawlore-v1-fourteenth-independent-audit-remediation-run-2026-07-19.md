# ClawLore v1.2.0 fourteenth independent-audit remediation run

Date: 2026-07-19

Status: source remediation verified on Linux; live/release remains NO-GO.

## Scope and independent adjudication

The fourteenth review was checked against the exact dirty candidate before any
change. Its package, branch, HEAD, 72 tracked modifications, 25 untracked paths,
candidate/live hashes, and non-deployed boundary matched the current source and
live state.

Both release blockers and all three should-fix findings were independently
reproduced. In particular, a placeholder credential match did suppress a later
real match in the same pattern, raw governance SQL changed truth without
changing lifecycle projection rows, conjunction-only ACL failure text was
misclassified, a malformed auxiliary state table caused an unrecoverable
column error, and stats/doctor could repair projection drift despite the
documented read-only contract.

No live extension, OpenClaw configuration, memory database, Gateway service,
Git remote, commit, tag, or release was changed in this remediation.

## Changes

### Complete shared secret scanning

- Every global secret pattern now scans all matches. A placeholder exempts only
  that exact match and cannot suppress a later real credential.
- Placeholder handling uses normalized whole tokens/templates instead of broad
  substring checks, so an ordinary password containing words such as
  `example` is not treated as a fixture.
- Capture safety, shared redaction, Experience transcript preparation, and
  nested support bundles use table-driven parity cases for placeholder-first,
  secret-first, multiple-type, nested-list, and nested-object inputs.

### Transactional lifecycle-projection ownership

- Candidate promotion, forgetting archive/delete, governance cleanup/rollback,
  and legacy hygiene migration now synchronize lifecycle projection inside the
  same SQLite transaction as each `memory_truth` mutation.
- Projection failure rolls back truth, projection, and the associated audit
  event together. Fault injection proves no partial commit.
- A source-governance gate confines direct `memory_truth` DML to an exact
  mutation allowlist and requires every allowlisted module to call the shared
  synchronization path.
- Projection health checks schema, truth/projection/state row counts, and
  per-row scope/update revision parity, so equal row counts cannot hide content
  drift.

### Auxiliary schema recovery and read-only doctor

- Projection table, state table, and index are one versioned auxiliary schema
  unit. Wrong object types, columns, index shape, missing state, or interrupted
  partial DDL lead to a transactional full auxiliary rebuild from SQL truth.
- `stats()` and doctor only inspect projection health. Drift produces an issue
  and empty lifecycle-derived counts rather than returning stale data or
  silently mutating the database.
- Ordinary reopen of an established SQL authority also leaves missing or
  drifted projection state untouched. Only fresh authority creation and the
  explicit receipt-backed legacy upgrade may initialize projection state.
- `clawlore repair-lifecycle-projection` is an explicit dry-run-first operator
  command; only `--apply` rebuilds the auxiliary schema and verifies parity.
  README, runbook, and architecture map now state that boundary.

### ACL conjunction scope

- Text fallback now recognizes a subject switch after conjunctions as well as
  adversative clauses. English and Chinese matrices cover `and`, `while`,
  `whereas`, `and ... either`, `而`, `同时`, and `也` around authorized and
  unauthorized subjects.
- Structured host/tool outcomes remain preferred; text is only the bounded
  fallback.

## Verification

- Focused blocker/should-fix regression groups: 26/26 and 18/18 passed.
- Full Linux suite: 498 total, 496 passed, 0 failed, 2 Windows-only skips.
- Post-document/source-governance regression: 28/28 passed.
- Strict TypeScript typecheck and build: passed; tracked `dist` rebuilt.
- Vector repair smoke: passed.
- Commercial golden: 124/124; MRR/NDCG/top-K 1; bad recall 0; cross-scope
  leakage 0.
- Honest doctor-path scale gate, including projection freshness inspection and
  lifecycle aggregation:
  - 200,000 rows: FTS p95 0.055 ms; lifecycle diagnostics 211.412 ms under the
    default 500 ms ceiling.
  - 1,000,000 rows: FTS p95 0.073 ms; lifecycle diagnostics 1,077.821 ms under
    an explicit 1,500 ms million-row ceiling.
  - Both runs retained known-answer recall 1 and cross-scope leakage 0.
- Dry-run package: 246 files.
- Installed tarball: runtime registration and LanceDB
  store/reopen/recall/delete/repair smokes passed.
- Isolated real OpenClaw under supported `/usr/bin/node` 24.15.0:
  installed/enabled/activated/loaded, doctor healthy, lifecycle projection
  healthy, and `clawlore`, `scope-recall`, and `memory-pro` all reported 1.2.0.
  A real row-revision drift then made doctor fail closed while projection/state
  snapshots stayed byte-for-byte equal across doctor and repair preview; only
  explicit `repair-lifecycle-projection --apply` rebuilt parity and restored a
  healthy doctor result.
- `git diff --check`: passed.

The scale script was deliberately tightened during verification. Previous
figures measured lifecycle aggregation only; the new figures include the
revision-parity inspection that doctor actually performs. This avoids claiming
an unrealistically low diagnostic latency. The million-row run declares its
1,500 ms ceiling explicitly; the default 500 ms ceiling remains the 200K gate
and was not silently relaxed. A preliminary unqualified million-row probe
correctly failed that 500 ms ceiling at 1,121.687 ms; it is retained as evidence,
not counted as a passing gate. The accepted million-row command was
`node scripts/scalability-benchmark.mjs --rows 1000000 --max-lifecycle-stats-ms 1500`.

## Release boundary

The source release gate still fails at the intended first external governance
barrier:

`package=github.com/410979729/clawlore` does not match
`origin=github.com/410979729/scope-recall-openclaw`.

The worktree remains an aggregate uncommitted candidate: 83 tracked dirty and
26 untracked paths after the complete remediation/documentation build. The
exact Windows Node 24 gate, a clean source+dist commit, publication at the
exact canonical remote ref, regenerated release evidence, version/tag
decision, and a new independent review of that clean commit remain mandatory.

The candidate runtime digest is
`0994933538d9f624d366a943dbac10e40a23d09b221ef450ff06c86b3ad4b095`;
live is
`25b0979c2476fe35f297c34eb3c65600900069240c4a5d0473c2696ff03128d5`.
Candidate `dist/index.js` remains `8226bfa4...`; live remains `95b1da2b...`.
The mismatch proves the remediation is not deployed.

## Cleanup

Package, install, benchmark, and isolated OpenClaw state roots were created in
validated temporary directories and removed by exit traps. No tarball,
SQLite database, log, cache, or scratch script remains in the project. Existing
workspace-outside state-hygiene findings were not created or deleted by this
round. The final audit still reports the same 93 pre-existing findings. The
dedicated `/tmp/clawlore-audit14-*` residue count is zero.
