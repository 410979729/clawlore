# ClawLore v1 sixth independent-audit remediation run — 2026-07-16

## Decision

The fifth independent audit findings against `575d09e` were accepted. All
three release blockers and all six should-fix findings were remediated in the
source candidate. The candidate remains **not authorized for publication,
deployment, or V2 cutover** until Tianxuan independently accepts the exact
delivered clean HEAD.

## Remediated release blockers

### SQL authority migration cannot leave a false-valid database

- Authority inspection is read-only and validates object type plus exact
  columns. `memory_truth_fts` must be the expected FTS5 virtual table; a
  same-named table, view, partial truth table, or wrong-column FTS is rejected.
- Ordinary startup no longer upgrades legacy authority state. Legacy upgrade is
  an explicit dry-run/apply operation requiring separate backup and receipt
  paths.
- Apply creates and verifies a SQLite backup before mutation and records its
  hash, source hash, schema version, row counts, and result in a private receipt.
- Schema DDL, FTS rebuild, validation, receipt binding, and marker creation run
  inside one savepoint. The authority marker is written last. Injected failures
  at DDL, FTS rebuild, marker, or commit boundaries leave no valid marker or
  trusted partial migration.
- Repeated apply is rejected after a successful receipt; a failed receipt does
  not grant authority.

### Windows ACL policy is exact and default-deny

- Privacy validation requires the current service SID as owner, a protected
  DACL, and exactly one allow ACE granting that SID full control.
- Unknown owners, unknown SIDs/groups, inherited allows, broad principals,
  object/conditional ACEs, and other unfamiliar allow entries fail validation.
- Hardening sets and rechecks the owner instead of only replacing one grant.
- The SQLite parent is privatized before database open. Expensive Windows ACL
  subprocesses no longer execute while the SQLite write lock is held; POSIX
  file-mode enforcement remains inside the mutation boundary so permission
  faults still roll back durable writes.

### OAuth reads enforce the same privacy contract as writes

- The OAuth parent directory and session file are verified private before token
  JSON is read.
- Reads reject symbolic links, wrong owner, broad POSIX mode, and invalid
  Windows ACL state.
- Supported POSIX platforms open with `O_NOFOLLOW`, read from the opened file
  handle, and compare opened-file identity to the inspected path to reduce
  exchange races.
- Diagnostics use stable redacted identifiers and never return the token value
  or absolute auth path.

## Remediated should-fix findings

- The localhost OAuth listener is created and awaited before the authorize URL
  is shown or opened. Immediate callback is therefore accepted instead of
  racing into `ECONNREFUSED`; browser-open failure closes the listener.
- Private parent creation and cached Windows policy avoid command-heavy ACL
  work inside every SQLite durable transaction.
- Legacy marker upgrade is explicit, backup-backed, receipt-bound, dry-run by
  default, and absent from ordinary startup.
- OAuth load/save/provider errors use redacted diagnostic summaries.
- The release gate packs the actual tarball, installs it in an empty production
  directory, runs the packed runtime smoke, then installs that same tarball
  through an isolated real OpenClaw CLI. It verifies extension activation,
  `clawlore`, `scope-recall`, `memory-pro`, authority inspection,
  Experience initialization, and doctor.
- Package script policy now distinguishes source-checkout commands from the
  packed runtime command. Changelog and generated evidence cover this security
  and migration round; evidence counts come from the exact gate output rather
  than hand-maintained prose.

## Regression and release evidence

The focused fault matrix covers malformed FTS objects and columns, partial
truth schemas, failures at migration DDL/FTS/marker/commit boundaries,
backup/receipt/idempotency behavior, unknown Windows owner and allow ACEs,
OAuth `0644`, symlink, owner/mode/identity faults, immediate callback ordering,
listener cleanup, path/token diagnostic canaries, and packed-package contracts.
The focused set passed 48/48 before the full suite.

The exact clean code commit is
`9aa7d2e29661f66bca6988db091b59770da7561f`. A fresh official-registry
lockfile install passed:

- 349/349 tests;
- TypeScript typecheck, build, and vector-repair smoke;
- 124/124 deterministic recall cases with Recall/MRR/NDCG 1, forbidden 0,
  and cross-scope leakage 0;
- the 200,000-row / 64-query synthetic SQLite FTS baseline;
- zero known production dependency vulnerabilities from the official registry;
- a 42-component SBOM with SHA-256
  `7fb05a4560832bf05b449978c6bf2315ddce59ce85e91962f3ae714383734fd7`;
- a 185-file extracted npm-pack filename/content scan;
- packed runtime smoke and packed real-OpenClaw CLI smoke;
- build `dirty=false`.

The recursive runtime digest is
`da95777445aeca89e5ef497ee3c270aeb859e05bee0e7b21e79cf70694db0cc4`.
Generated release evidence bound the exact code commit, digest, pack/SBOM
counts, SBOM hash, official registry, and both packed smokes.

## Live boundary

Read-only verification found the existing
`openclaw-gateway-tianji.service` active/running and health live on port
`19021`. The memory slot still selects `scope-recall-openclaw@1.1.0`;
the ClawLore candidate has not been deployed. Live SQLite quick-check was
`ok`, truth/FTS counts were 1031/1031, and SQLite/WAL/SHM were `0600`.
Telegram remains sender-allowlisted and all configured group boundaries deny
the declared memory/governance tool surface.

This turn did not restart the Gateway, mutate live configuration or memory
data, push a remote, tag/release a package, deploy the candidate, promote V2
lifecycle, or authorize cutover.

## Evidence limits

- The Windows policy was exercised on Linux through deterministic command/ACL
  fixtures. No real Windows runner, second-account read test, or concurrent
  SQLite p95 benchmark was available in this acceptance run.
- The 124-case and 200,000-row results are deterministic engineering fixtures,
  not independent human relevance evaluation, real provider/reranker evidence,
  or long-running LanceDB/multiprocess soak.
- A successful source/package gate does not authorize live replacement. Backup,
  migration, canary, SecretRef CLI, Telegram multi-session, restart fault, and
  rollback drills remain deployment-stage gates after independent acceptance.

## Next gate

Provide Tianxuan the exact delivered clean HEAD, code commit, runtime digest,
generated release evidence, this report, and preceding audit reports for a
sixth independent read-only audit. Repository push and live deployment remain
separately gated.
