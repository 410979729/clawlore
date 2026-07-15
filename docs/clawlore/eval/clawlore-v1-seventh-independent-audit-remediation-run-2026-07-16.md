# ClawLore v1 seventh independent-audit remediation run — 2026-07-16

## Decision

The sixth independent audit findings against
`71347fc96e9fad23035ac25edc3bc7151cf02a1a` were accepted. All five release
blockers and all six should-fix findings were remediated in the source
candidate. The candidate remains **not authorized for repository push,
publication, live deployment, or V2 cutover** until Tianxuan independently
accepts the delivered clean HEAD.

## Remediated blockers

- Windows ACL enforcement uses an encoded PowerShell program. Path, SID, kind,
  and mode travel only through structured environment input; no local path is
  interpolated into PowerShell source or positional `-Command` arguments.
- SQL authority version 3 is bound to an exact normalized schema fingerprint.
  Inspection verifies truth PK/constraints, indexes, triggers, repair outbox,
  marker/migration tables, and the complete FTS5 definition before reporting
  `valid`.
- Migration canonicalizes source, backup, and receipt path identities before
  any write. Relative aliases, symlinked parents, source/WAL/SHM aliases,
  identical backup/receipt targets, shared parents, and high-risk directories
  are rejected.
- Backup creation is followed by file and parent fsync, SHA-256, a logical
  snapshot digest, and a prepared receipt. Upgrade then takes a SQLite writer
  lock and compares the locked source digest to the backup. Concurrent source
  changes abort before marker creation.
- Only missing owner-private directory suffixes are created. Existing parent
  directories are verified and never chmod'd or have their ACL rewritten.

## Remediated should-fix findings

- The internal SQLite migration receipt is authoritative. If external
  completed-JSON persistence fails after commit, the same command reconstructs
  it idempotently without re-running the migration.
- Release-gate npm scripts use a cross-platform Node wrapper with `shell:false`.
- The packed tarball runs a native LanceDB store/reopen/recall/delete/repair
  smoke in addition to the native-free runtime and real OpenClaw CLI smokes.
- Release evidence is generated directly by the gate. Handoff prose no longer
  acts as the numeric truth source.
- TypeScript strict mode is enabled and the unreachable legacy vector-first
  fallback branches were removed. Large-module decomposition remains a later
  characterization-test-backed refactor, not part of this security repair.

## Regression evidence

The regression matrix includes malformed PK/constraint and fingerprint
objects; source/backup/receipt aliases; symlinked parents; shared-parent mode
preservation; backup fsync faults; concurrent same-row UPDATE after backup;
post-commit external receipt interruption; nested fresh state creation; public
ancestor refusal; encoded PowerShell input; default-deny unknown owner/ACE;
and installed native LanceDB restart/delete behavior.

Exact clean code commit:
`854591269632d31e03d5fc500ebdc4168d7257f4`.

Machine-generated source-gate evidence:

- 361 tests passed, 0 failed, 1 Windows-only integration skipped on Linux;
- strict TypeScript typecheck, build, and vector-repair smoke passed;
- 124/124 deterministic recall, MRR/NDCG 1, forbidden 0, leakage 0;
- 200,000 rows / 64 queries, recall 1, leakage 0, p95 0.070 ms;
- official npm registry production vulnerabilities: 0;
- SBOM: 42 components, SHA-256
  `095c805f4e5306bd6a565997f1278fb1941383dfd8d318167c79a022d124aff9`;
- npm pack filename/content scan: 186 files;
- packed runtime, packed native LanceDB, and packed real OpenClaw CLI smokes:
  all true;
- build/source state: `dirty=false`;
- runtime digest:
  `0883f4b2fd7ad419f88b5784c2741c190dbdc95c838e4d44b98a0f5b78bcb270`.

The unedited gate JSON is retained beside this report as
`clawlore-v1-seventh-release-evidence-2026-07-16.json`.

The first exact gate attempt exposed one fresh-install regression: a private
state leaf could not be created when more than one dedicated path component
was missing. The fix creates and enforces only the missing suffix beneath an
already private ancestor, never mutating that ancestor. Focused regressions and
the complete exact gate then passed.

## Live boundary and evidence limits

No candidate file, live SQLite/LanceDB data, plugin config, memory slot, or V2
control was changed. No Gateway restart, push, tag, release, or deployment was
performed. Live remains the old `scope-recall-openclaw@1.1.0` data plane plus
the prior read-only ClawLore shadow boundary.

The authorized Windows client was unreachable through its registered
management path during this run, so no claim is made for a real second-account
Windows ACL test or Windows concurrent-write benchmark. A conditional test now
runs the real encoded PowerShell helper on Windows; Linux regression fixtures
prove command construction and ACL decision semantics only. The recall and
scale suites are deterministic engineering evidence, not a commercial canary
or long-running multiprocess/provider study.

## Next gate

Give Tianxuan the delivered clean HEAD, this report, the generated evidence,
and prior audit chain for a seventh independent read-only review. Repository
push and live rollout remain separate, explicit gates.
