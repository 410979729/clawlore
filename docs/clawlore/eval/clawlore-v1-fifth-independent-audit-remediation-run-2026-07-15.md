# ClawLore v1 fifth independent-audit remediation run — 2026-07-15

## Decision

The fourth independent re-audit findings against `27e41fd` were accepted. Both
release blockers and all five should-fix findings were remediated in the source
candidate. The candidate remains **not authorized for publication, deployment,
or V2 cutover** until Tianxuan independently accepts the exact clean commit.

## Remediated release blockers

### Existing files must prove SQL authority before schema mutation

- Startup inspects an existing `memory.sqlite3` read-only before any schema
  creation or migration.
- A valid authority requires the versioned `clawlore_sql_truth_authority`
  marker plus the expected truth/FTS structure.
- Zero-byte files, valid-but-empty SQLite files, partial unmarked schemas, and
  unreadable/corrupt files fail closed. They cannot be auto-healed into a
  healthy empty authority that silently hides companion data.
- A fresh authority is created only when truth is absent and the companion is
  empty. A structurally complete non-empty legacy truth may receive the marker
  once during the controlled 1.1→1.2 upgrade.
- A marker-backed zero-row authority, including durable delete repair debt,
  remains a valid authority and continues to suppress stale companion rows.

### OAuth persistence is private, atomic, and symlink-safe

- OAuth refresh writes an exclusive same-directory temporary file, fsyncs it,
  enforces private permissions, atomically renames it, verifies the final path,
  and fsyncs the parent directory.
- Replacing an existing `0644` file produces a `0600` final file on POSIX.
- Existing/final symlinks are rejected before replacement, and a pre-rename
  failure leaves the previous complete file untouched.
- A post-rename directory-sync failure can report durability uncertainty but
  cannot leave partial JSON or a broad-permission token file.
- Concurrent refreshes leave one complete JSON document and no temporary-file
  residue.

## Remediated should-fix findings

- OAuth callbacks validate state with constant-time comparison before handling
  provider errors. Callback pages use fixed messages or escaped text and add
  CSP, `Cache-Control: no-store`, and `X-Content-Type-Options` headers.
- Production operator/model-visible errors across migration, extraction,
  compaction, upgrade, task-experience, digest, embedding, forgetting, OAuth,
  and rollout paths use structured redacted diagnostic summaries.
- The operator runbook now states that `SQL_TRUTH_MIGRATION_REQUIRED` supports
  verified-backup restoration only in this release. The legacy hygiene script
  is explicitly not a companion-to-truth recovery command.
- sqlite-bruteforce startup uses `SELECT 1 ... LIMIT 1` through `hasRows()` for
  the Boolean companion check instead of materializing every id.
- One shared file-privacy adapter enforces POSIX owner-only modes and a verified
  protected Windows DACL; broad Everyone/Authenticated Users/Users grants are
  removed and a remaining broad allow ACE is a hard failure.

## Regression evidence

Focused regression covers zero-byte, empty SQLite, partial schema, corrupt,
directory-path, and permission-denied authority states; valid marker-backed
zero-row recovery; fresh marker creation; controlled non-empty legacy upgrade;
OAuth existing-mode hardening, symlink refusal, pre/post-rename faults,
concurrent refreshes, callback state ordering and HTML escaping; diagnostic
canaries; POSIX modes; and Windows DACL enforcement. The focused set passed
21/21.

The exact clean code commit is
`06a7d4bb5c343b7bacc920fcc0e5ca3b82103404`. A fresh lockfile install repeated
the complete source gate with 335/335 tests, typecheck, build, vector repair,
124/124 deterministic recall with zero cross-scope leakage, the 200,000-row
SQLite FTS baseline, official-registry production audit with zero known
vulnerabilities, a 42-component SBOM, and a 183-file extracted npm-pack
filename/content scan. Build left the tree clean. The recursive runtime digest
was `965540c5fb665d0ad4b351800459ef652c963612547d0426327516aefedc334a`.

An isolated OpenClaw `2026.7.1-beta.5` state loaded `clawlore@1.2.0` as
`loaded`, `enabled`, and `activated`, selected it for the memory slot, and
registered `clawlore`, `scope-recall`, and `memory-pro`. After explicit empty
Experience-schema initialization, doctor returned `ok=true`; all three command
identities returned matching zero-row SQL/FTS/vector stats with zero repair debt
and zero scan-budget exhaustion.

## Live operational correction and rollout boundary

- The audit's `19421` config versus `19021` service split was corrected under a
  controlled config backup. Config, service listener, health endpoint, and the
  ordinary OpenClaw CLI now all resolve to `19021`.
- The restart at `2026-07-15 22:41:08 +08:00` loaded only the existing live
  configuration/runtime. It did not deploy this candidate.
- Live remains `scope-recall-openclaw@1.1.0`; no candidate extension, memory
  slot, database truth, or V2 rollout control was changed.
- V2 still has zero active rows, so cutover remains fail-closed regardless of
  source-gate success.
- The deterministic recall and SQLite scale runs are engineering evidence, not
  independent human relevance or commercial-scale evidence.

## Next gate

Provide Tianxuan the final clean HEAD, runtime digest, source-gate output, this
report, and the preceding remediation reports for independent read-only
re-audit. Repository push and any live deployment remain separately gated.
