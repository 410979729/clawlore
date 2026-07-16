# ClawLore v1 eighth independent-audit remediation run — 2026-07-16

## Decision

The seventh independent audit findings against
`6d7917273b76cd5f9d52f037b4e5c4a621cd69ed` were accepted. The four release
blockers and the release-facing should-fix items were remediated in the source
candidate and covered by focused regressions. The Linux clean source gate is
green. The candidate remains **not authorized for repository push,
publication, live deployment, or V2 cutover**: the final real-Windows gate and
an eighth independent read-only review are still required.

## Remediated blockers

### Trusted ancestor versus private leaf

`ensurePrivateDirectory()` now applies two distinct policies. An existing
ancestor is accepted only when its owner is the current SID, `SYSTEM`, or
`Administrators` and no untrusted SID has write-capable access. The newly
created ClawLore suffix is still rewritten to a protected, current-SID-only
ACL. POSIX ancestors may be owner-correct `0755`, but group/other-writable
ancestors are rejected. Existing ancestors are never rewritten.

This closes the Windows first-install failure without weakening the final
private leaf. Regressions cover trusted inherited `SYSTEM`/`Administrators` /
current-user ACLs, untrusted `Modify`, POSIX `0755`, POSIX `0775`, and nested
missing suffix creation.

### Windows file durability

Migration backup durability opens the file with a writable handle before
`fsync`. Atomic JSON receipts are created with an exclusive writable handle,
written through that handle, ACL-hardened, synced through the same handle, and
renamed. POSIX directory fsync remains platform-specific instead of being
assumed to work on Windows.

Fault injection now covers prepared-receipt temp sync before and after fsync,
rename boundaries, post-commit receipt recovery, and retryability.

### Exhaustive authority schema policy

SQL authority schema version 4 preserves the exact expected-object
fingerprint and additionally enumerates unexpected triggers attached to
truth, FTS shadow, repair-outbox, authority, and migration tables. Unexpected
user-defined indexes on protected tables and unexpected ClawLore-namespace
views also invalidate authority.

Regressions add arbitrary-name `AFTER INSERT`, `BEFORE UPDATE`, and
`BEFORE DELETE` triggers, an unexpected protected-table index, and an
unexpected namespace view. Every valid fixture must also pass durable CRUD,
FTS, and reopen checks; a trigger that silently deletes an inserted row can no
longer be reported as `valid`.

### Fully bound external migration receipt

External receipt schema version 3 binds migration id; source, backup, and
receipt basenames; backup and logical snapshot digests; row count; lock
protocol; prepared/durable/completed timestamps; and post-inspection state to
the internal SQLite migration evidence. The backup is re-hashed and inspected
before a completed receipt is accepted.

A readable but incorrect `status=completed` JSON is now recoverable corruption,
not proof of completion. Internal evidence plus the verified backup rebuilds
the external receipt idempotently. Regression coverage independently corrupts
each bound field and also covers truncated JSON.

## Remediated should-fix findings

- The five read-only management tools preserve the reserved system
  `scopeFilter=undefined` full-bypass contract. The two mutation tools require
  an explicit write scope for system callers instead of silently translating
  bypass to deny-all.
- A compatible pre-marker `vector_companion_repair_outbox` is included in the
  legacy logical snapshot and migrated transactionally. An incompatible
  outbox blocks migration instead of being dropped.
- The release evidence is generated at a canonical path and bound to a
  SHA-256 digest of tracked release inputs. Audit-ledger documents are
  deliberately excluded from that digest to avoid a self-referential commit
  hash while code, tests, lockfile, CI, package metadata, and compiled output
  remain covered.
- The evidence records Node/npm/OS/architecture, lockfile SHA-256, SBOM
  format/tool/spec/hash/count, package count, runtime digest, compatibility
  ranges, and allowed platform variance. A normal gate compares stable fields
  with the checked-in evidence and fails on drift.
- A visible GitHub Actions matrix now runs the same source gate on Linux and
  Windows with Node 24.14.0 and a supported OpenClaw fixture. Windows uses a
  dedicated user-profile test temp root rather than a broadly writable system
  temp ancestor.
- `package.json` and `package-lock.json` declare Node 24, Linux/Windows, and an
  optional OpenClaw `>=2026.7.1-beta.2 <2027` peer boundary. The changelog now
  has `Unreleased` first and dates 1.2.0.
- Large-module decomposition remains accepted architectural debt. The new
  regressions provide characterization coverage around the changed authority,
  migration, privacy, and tool-boundary behavior; this security repair does
  not mix in a broad module rewrite.
- The real-Windows run exposed a second layer of portability defects after the
  audit's four blockers: V2 operator readers were still checking POSIX mode
  bits, encrypted/archive/observation outputs did not always enforce DACLs,
  two SQLite rewrite failure paths leaked handles, concurrent OAuth writers
  could race an atomic rename, module-boundary tests assumed `/`, and one
  vector test retained a store handle. These were fixed with the centralized
  privacy adapter, per-path OAuth serialization, deterministic close paths,
  platform separators, and explicit output hardening.
- The source gate correctly detected stale tracked `dist/` output after those
  changes. The compiled runtime was rebuilt and committed, so the final clean
  gate covers matching source and distribution artifacts.

## Linux clean source-gate evidence

Exact clean code commit:
`b75e0b06e4f2701c670f114a8d1f0a25d6056250`.

Machine-generated evidence:

- 380 tests total: 379 passed, 0 failed, 1 real-Windows integration skipped;
- strict TypeScript typecheck, build, and vector-repair smoke passed;
- 124/124 deterministic recall, MRR/NDCG 1, forbidden 0, leakage 0;
- 200,000 rows / 64 queries, recall 1, leakage 0, p95 0.062 ms;
- official npm registry vulnerabilities: 0;
- SBOM: 42 components, SHA-256
  `66fe1ba42753e7a8bca26919ac79380b5ddee76ddcc3997e34a916293674e0a9`;
- npm pack filename/content scan: 186 files;
- packed runtime, native LanceDB, and isolated real OpenClaw CLI smokes: true;
- build/source state at evidence capture: `dirty=false`;
- tracked release-input digest:
  `925923b9bb3ce462e36503ea4c43d18e16b4abe6b5f2e62f7b832ec2d15e9f57`;
- runtime digest:
  `358a22ef60077035bc40aa4dbfa01b78111d63b395373f18e408bf6531479d22`.

The canonical machine evidence is
`clawlore-v1-release-evidence.json`. A final normal-mode clean gate must still
prove that the checked-in evidence matches the delivered release inputs.

## Windows status and live boundary

The authorized Windows work computer was reachable over Tailscale and accepted
an isolated audit checkout under
`C:\\Users\\Administrator\\.clawlore-audit-ed81bfa`, a private test root, and
a disposable OpenClaw host fixture. Node 24 dependencies were installed only
inside those audit locations. The first real-Windows focused gate passed 60
tests with seven platform skips and no failures, then the broader gate exposed
portable-privacy, handle-lifetime, and concurrency defects that Linux masked.
After the corresponding fixes, the final affected-suite rerun passed the
durable rewrite suite and the initial unsafe-rewrite cases before the client
disappeared from the tailnet.

No live Windows plugin, service, system configuration, or user data was
changed, but isolated audit directories were changed and remain to be removed
when the authorized client is reachable. The exact final Windows source gate
therefore remains pending. This report does not claim cross-platform release
acceptance.

No candidate file, live SQLite/LanceDB data, plugin config, memory slot, or V2
control was changed. No Gateway restart, push, tag, release, or deployment was
performed. Live remains `scope-recall-openclaw@1.1.0` until a separately
authorized rollout.

## Next gate

1. Run the exact committed candidate through the real Windows Node 24 source
   gate, including first-install ACL creation and legacy authority migration.
2. Run the final normal-mode Linux clean gate against the checked-in evidence.
3. Give Tianxuan the delivered clean HEAD, this report, canonical evidence, and
   prior audit chain for an eighth independent read-only review.
