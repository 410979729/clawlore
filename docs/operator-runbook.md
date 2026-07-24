# ClawLore Operator Runbook

Status: Phase 7 commercial release hardening baseline.

Use this runbook when preparing or validating a live
ClawLore rollout.

## Source Gate

Run from the plugin workspace:

```bash
npm ci --ignore-scripts --include=dev
npm run preflight:dependencies
npm run release:prepush
```

The pre-push gate includes the full test/typecheck/build/benchmark/package scan,
SBOM, dependency-integrity preflight, and an advisory audit pinned to the
official npm registry. A missing dependency, advisory endpoint failure, or
transport failure is a red gate; none may be interpreted as zero findings.
The gate also requires the candidate worktree to remain clean after build in
both source-only and live-artifact modes; generated artifact drift is a red
gate. It packs the real npm tarball, installs that tarball into an empty
production-only directory, resolves the supported OpenClaw SDK, and loads the
installed `clawlore`, `scope-recall`, and `memory-pro` CLI registration surface.
The package metadata marks `smoke:packed-runtime` as the only published runtime
script; all other npm scripts require a source checkout and are not public
installed-package capabilities.

Pre-push mode is explicitly non-authorizing: it requires a clean commit and a
canonical origin identity, but does not claim the commit is already published
and cannot write canonical release evidence. After the commit is pushed, run
the strict source gate against the exact remote ref:

```bash
npm run release:gate:source -- --release-ref refs/heads/main
# or: --release-ref refs/tags/vX.Y.Z
```

Only the strict post-push gate verifies remote publication and canonical
release evidence. A green pre-push result is never a release authorization.

Do not continue to live rollout until all source gates pass and an independent
audit approves the exact candidate commit.

If SQL truth cannot initialize because the database is corrupt, unreadable, a
directory, or schema-incompatible, ClawLore intentionally refuses reads and
writes with `CLAWLORE_SQL_TRUTH_UNAVAILABLE`. Do not enable vector-only recall.
Restore or repair the SQLite authority from a verified backup, run doctor and
the vector-repair dry run, then repeat the clean source/live gate.

If `memory.sqlite3` is missing, zero-length, schema-less, marker-less at zero
rows, or otherwise lacks an established authority while the vector companion
still contains rows, startup stops with
`CLAWLORE_SQL_TRUTH_MIGRATION_REQUIRED`. Ordinary startup never imports
companion rows into truth. The supported recovery is restoration of a verified
SQLite authority backup, followed by `doctor` and vector-repair dry-run. This
release does not ship or support companion-to-truth recovery. In particular,
`scripts/migrate-legacy-hygiene.mjs` only repairs metadata hygiene inside an
already valid SQL authority; it is not a vector recovery command. Never rename,
truncate, recreate, or delete the truth file to force vector recovery.

New stores may create an authority only when both the SQL truth and companion
are absent/empty. The created database contains a versioned
`clawlore_sql_truth_authority` marker. A structurally complete, non-empty legacy
truth database may receive that marker only through the controlled, explicit,
backup-backed 1.1→1.2 schema upgrade; an empty or partial unmarked database is
never upgraded implicitly. Preview first, then apply with operator-reviewed
paths outside the live database directory:

```bash
openclaw clawlore authority inspect --db /path/to/memory.sqlite3
openclaw clawlore authority migrate \
  --db /path/to/memory.sqlite3 \
  --backup /private/backup/memory.sqlite3 \
  --receipt /private/receipts/clawlore-authority-migration.json

openclaw clawlore authority migrate \
  --db /path/to/memory.sqlite3 \
  --backup /private/backup/memory.sqlite3 \
  --receipt /private/receipts/clawlore-authority-migration.json \
  --apply
```

Ordinary plugin startup never performs the legacy upgrade. The apply command
requires the backup and receipt to use different, dedicated owner-only leaf
directories. Existing directories are verified but never chmod'd or have their
ACL rewritten; a shared, non-private, non-empty, root, home, temp-root, or live
database directory is rejected before any output is created. Relative paths,
symlinked parents, case aliases, the source DB, and its WAL/SHM companions are
resolved before the three paths are required to be pairwise distinct.

Before changing the source, apply creates the SQLite backup, fsyncs the backup
and its parent directory, verifies its hash and logical snapshot, and writes a
prepared receipt. The schema upgrade then takes a SQLite `BEGIN IMMEDIATE`
writer lock and compares the locked source snapshot to the durable backup;
concurrent UPDATE/INSERT/DELETE activity aborts the migration before the
authority marker is written. Quiescing the gateway is still recommended to
avoid an expected abort under traffic, but row counts alone are never accepted
as consistency evidence. The internal SQLite migration receipt is the commit
truth. If writing the external completed JSON is interrupted after commit,
re-running the same command reconstructs that receipt idempotently instead of
reapplying the migration. A completed authority refuses a second migration.

Doctor/dashboard diagnostics expose `scanBudgetExhaustions` and
`lastScanBudgetExhaustedAt`. A new exhaustion means stale companion rows
consumed the bounded 5,000-row scan before enough SQL-valid results were found.
Run vector-repair dry-run, review the debt, apply repair only under operator
authority, and then recheck diagnostics.

Lifecycle diagnostics use the rebuildable `memory_lifecycle_projection`
auxiliary tables. They are not SQL authority. Fresh authority creation and the
explicit receipt-backed legacy upgrade initialize projection state; ordinary
startup never creates, backfills, or repairs it. Truth mutations update an
already healthy projection in the same transaction and fail closed if its
schema is unavailable. Doctor is read-only with respect to SQL truth and this
projection: it reports schema, row-count, or revision drift without rebuilding
the auxiliary tables, including while reopening an established database. If it
reports drift, stop and inspect the SQL authority; do not edit projection rows
by hand or interpret a partial projection as truth. Preview and apply the
bounded repair explicitly only after confirming SQL truth is healthy:

```bash
openclaw clawlore repair-lifecycle-projection --json
openclaw clawlore repair-lifecycle-projection --apply --json
```

The bare command is a dry run. The apply form transactionally rebuilds the
projection table, state row, and index from `memory_truth`, then verifies row
and revision parity before reporting success.

TaskEpisodes created before the explicit promotion-review gate are reported as
`legacy_episode_historical`. They are intentionally ineligible for automatic
promotion. Do not edit their metadata to manufacture `promotion_eligible` or
reviewer approval. Until a separate actor/reason/evidence review receipt flow
is implemented, treat them as non-promotable historical records.

## Memory quality and secret-at-rest gate

Manual `memory_recall` is an observation-only operation. It must not increment
access counters, set `last_confirmed_use_at`, clear bad-recall feedback, or
change suppression state. A release is rejected if the static guard or the
read-only regression test detects any metadata patch from that tool. Positive
feedback belongs to a separate, explicit governance action with actor and
reason evidence.

Before any rollout, run the source-checkout persisted-secret audit against
every memory-bearing SQLite authority, companion database, and every declared
backup/export/restore root:

```bash
node scripts/clawlore-persisted-secret-audit.mjs \
  --memory-db /private/live/memory.sqlite3 \
  --conversation-db /private/live/conversation-memory.sqlite3 \
  --lancedb-dir /private/live/lancedb-root \
  --artifact-root /private/live/backups \
  --artifact-root /private/live/exports \
  --receipt /private/receipts/persisted-secret-audit.json
```

The receipt is owner-only and content-free: it contains counts, pattern names,
path hashes, and bounded inventory coverage, never row text, identifiers, or
secret values. Artifact roots are mandatory and repeatable. Unsupported files,
unrecognized encrypted containers, omitted artifact roots, any finding, or
non-private mode on a SQLite database/WAL/SHM, artifact tree, or anywhere
inside the LanceDB tree is a deployment blocker. Merely renaming plaintext
with an encrypted-looking extension does not satisfy the gate. The OpenClaw
transcript database remains read-only source evidence, and controlled OpenClaw
auth stores are never generic-redaction targets.

Quiesce every automatic writer, rotate potentially exposed credentials outside
ClawLore, and create three fresh encrypted recovery points. Each workflow
performs an actual isolated restore and removes the plaintext test copy:

```bash
node scripts/clawlore-encrypted-live-snapshot.mjs \
  --source /private/live/memory.sqlite3 \
  --archive /private/backups/memory.clawlore2 \
  --restore-test /private/restore-test/memory.sqlite3 \
  --receipt /private/receipts/memory-snapshot.json \
  --key-id <controlled-key-id> --secret-ref /private/vault/snapshot.key

node scripts/clawlore-generic-encrypted-live-snapshot.mjs \
  --source /private/live/conversation-memory.sqlite3 \
  --archive /private/backups/conversation.clawlore2 \
  --restore-test /private/restore-test/conversation.sqlite3 \
  --receipt /private/receipts/conversation-snapshot.json \
  --key-id <controlled-key-id> --secret-ref /private/vault/snapshot.key

node scripts/clawlore-vector-companion-encrypted-live-snapshot.mjs \
  --source-root /private/live/lancedb-root \
  --archive /private/backups/vector.clawlore2 \
  --restore-test-root /private/restore-test/vector \
  --receipt /private/receipts/vector-snapshot.json \
  --key-id <controlled-key-id> --secret-ref /private/vault/snapshot.key
```

Then generate a fresh read-only exact plan. Review its content-free target
counts and retain its digest; a prior digest is invalid after any source or
projection-identity change:

```bash
node scripts/clawlore-persisted-secret-remediation.mjs \
  --memory-db /private/live/memory.sqlite3 \
  --conversation-db /private/live/conversation-memory.sqlite3 \
  --lancedb-dir /private/live/lancedb-root \
  --artifact-root /private/live/backups \
  --artifact-root /private/live/exports \
  --receipt /private/receipts/remediation-plan.json
```

Only an explicitly authorized operator may apply that exact plan:

```bash
node scripts/clawlore-persisted-secret-remediation.mjs \
  --memory-db /private/live/memory.sqlite3 \
  --conversation-db /private/live/conversation-memory.sqlite3 \
  --lancedb-dir /private/live/lancedb-root \
  --artifact-root /private/live/backups \
  --artifact-root /private/live/exports \
  --receipt /private/receipts/remediation-apply.json \
  --apply --approved --credentials-rotated --tighten-permissions \
  --expected-plan-digest <reviewed-digest> \
  --memory-snapshot-receipt /private/receipts/memory-snapshot.json \
  --conversation-snapshot-receipt /private/receipts/conversation-snapshot.json \
  --vector-snapshot-receipt /private/receipts/vector-snapshot.json
```

The operation hard-purges affected V1/V2 truth, history, FTS and vector rows,
structurally redacts non-memory records, verifies SQL integrity/FKs, rescans all
stores, and tightens persisted-store permissions. Do not treat deletion from
one mirror as complete remediation. If it raises
`CLAWLORE_PERSISTED_SECRET_REMEDIATION_RECOVERY_REQUIRED`, do not retry or claim
that SQL rollback restored the LanceDB side. Restore all verified snapshots to
isolated paths, validate them, and obtain a new plan.

Recall quality evidence must use a schema-v2 operator-annotated corpus with at
least 30 positive cases and 10 no-answer cases. The gate records Recall@3,
Precision@3, MRR, abstention rate, and false-positive results. An offline
deterministic embedding run is reproducibility evidence only; it cannot set
`liveProviderSemanticReady=true`. The final semantic gate must use the same
live embedding provider through an owner-only key file and must pass the
negative/no-answer thresholds before automatic recall or deployment can be
approved. `expected_ids` are mandatory answers used for Recall/MRR;
operator-reviewed `relevant_ids` may identify supporting results used only for
Precision/false-positive scoring. They must be disjoint from required and
forbidden IDs, and no-answer cases may not declare relevant results.

The supported transcript source is the current OpenClaw SQLite transcript
store, not legacy JSONL. Use one exact session and an explicit target identity:

```bash
openclaw clawlore digest run \
  --transcript-db /private/openclaw-agent.sqlite \
  --transcript-session-id <exact-session-id> \
  --principal-key <platform:account:principal> \
  --transcript-since-ms <inclusive-epoch-ms> \
  --dry-run --json
```

The reader opens SQLite read-only/query-only and requires owner-only database,
WAL, and SHM files. It admits only user/assistant text and assistant tool names;
tool arguments, tool results, thinking, custom events, session keys, and raw
session identifiers are excluded. An empty eligible window is an error. The
default remains dry-run, and transcript evidence never becomes durable truth
without the existing explicit candidate-review and apply boundaries. Shipping
this reader does not modify or authorize an existing cron job.

For V2 write operators, convergence, integrity, and foreign-key checks must
pass before commit. If a committed run returns
`CLAWLORE_V2_POST_COMMIT_RECOVERY_REQUIRED`, do not retry against the same
destination and do not claim that a transaction rollback restored it. Restore
the verified encrypted pre-write snapshot to a new location, validate that
copy, preserve V1 fallback, and obtain a fresh bounded plan before any retry.

## V2 authority cutover and V1 retirement

Treat runtime modes as a one-way, evidence-gated progression:
`disabled -> shadow -> v2-write -> cutover`. A rollback may move to an earlier
mode by restoring the verified snapshot and configuration pointer; do not
reverse-mutate a partially migrated database.

During `v2-write`, use `agentToolProfile: "v2-write"`. It exposes
`memory_store` but not legacy update/forget tools, and the runtime refuses to
activate while automatic capture, smart extraction, or reflection writers are
enabled. This prevents an unmirrored legacy writer from reopening V1/V2 drift.

Before requesting cutover, stop every writer outside ClawLore and run:

```bash
npm run preflight:clawlore-v2-cutover -- /absolute/path/memory.sqlite3
```

The command is read-only and exits non-zero while `cutoverReady` is false.
Resolve every reported blocker, generate an exact unexpired cutover readiness
receipt, set `runtime.mode: "cutover"` and
`runtime.contextEngine: "native-opt-in"`, and select the host engine with
`plugins.slots.contextEngine: "clawlore"`. The plugin registers the same
`clawlore` engine id because OpenClaw uses the slot value for both plugin
loading and engine resolution.

Do not delete or stop preserving V1 merely because cutover succeeds. Keep the
verified rollback snapshot and read-only V1 lane for the approved observation
window. Retire V1 from the normal runtime only when a fresh preflight reports
both `cutoverReady: true` and `v1RetirementReady: true`; thereafter V1 is an
offline migration/archive format, not a parallel authority.

## Live Rollout

1. Record the candidate commit and recursive artifact digest.
2. Back up the live extension, `openclaw.json`, and SQLite truth store.
3. Stage exactly one canonical `extensions/clawlore` copy. Do not enable the
   legacy and canonical plugin copies together because they expose the same
   memory slot and tool contracts.
4. Move the config entry and memory slot to `clawlore` while preserving its
   `dbPath`, conservative runtime flags, and canonical `runtime` controls.
   Existing `clawloreV2` input is a deprecated migration alias only; do not
   write both keys unless their normalized values are identical.
   Auth commands now perform this identity move as one complete config
   migration when only the legacy entry exists. If canonical and legacy entries
   both exist with different contents, they stop without writing. OAuth login
   also refuses plaintext API-key backup material, and logout commits the
   restored config before deleting OAuth files.
5. Push the clean candidate commit to the exact release branch or tag. The gate
   defaults to `refs/heads/main` and requires local `HEAD` to equal that remote
   ref; remote reachability alone is not sufficient.
6. If `legacyAgentScopePrincipals` is non-empty, obtain the exact canonical
   `platform:account:principal` key from trusted OpenClaw adapter metadata for
   the direct user being authorized. Do not derive it from a display name, chat
   title, group id, wildcard, or user-supplied envelope text. Confirm that the
   same exact key appears in the reviewed allowlist.
7. Restart once, then run the live gate from the clean candidate:

   ```bash
   npm run release:gate -- \
     --principal 'telegram:default:<numeric-user-id>' \
     --release-ref refs/heads/main
   ```

   Omit `--principal` only when there is no legacy allowlist and no principal-
   specific visibility decision. `CLAWLORE_RUNTIME_PRINCIPAL` and
   `CLAWLORE_RELEASE_REF` are environment-variable equivalents for controlled
   automation. A missing principal with an active exact allowlist, a mismatched
   principal, or an unpushed local commit fails with a directed error.

## Live Smoke

Use the current OpenClaw home:

```bash
OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw plugins inspect clawlore --json

OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw clawlore doctor --json --quiet

OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw clawlore dashboard --json

OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw clawlore digest report --json

OPENCLAW_HOME=/path/to/openclaw-state \
  openclaw clawlore experience stats --json
```

Safe recall probes should use a non-secret query and must not force memory
writes. If doctor is degraded, record the exact degraded field before deciding
whether to repair or roll back. `SQL_TRUTH_UNAVAILABLE` is not a degraded mode;
it is a fail-closed outage that requires authority-store recovery.

## Rollback

Rollback restores the legacy extension and configuration backup as one unit,
then re-runs plugin inspect, doctor, dashboard, health, and a read-only recall
probe. Do not delete the backups until the replacement has passed live smoke.
