# ClawLore v1.2.0 thirteenth independent-audit remediation run

Date: 2026-07-19

Status: source remediation verified on Linux; live/release remains NO-GO.

## Scope and adjudication

This round reviewed both the static live audit and the thirteenth independent
candidate review before changing source. The thirteenth review is the stronger
release decision source because it binds the exact dirty candidate, supplies
counterexamples, and includes executed tests and scale measurements.

The static audit's three P0 scope claims were not accepted as demonstrated
external authorization failures. The public write/Experience entry points
already resolve authenticated runtime access, and the existing foreign-scope
security regressions pass. Cross-private-scope duplicate detection would also
create an existence side channel. No cross-tenant dedup or redundant repository
authorization layer was added in this round.

The static audit did identify two valid themes that were accepted: secret
detection/redaction rules had drifted across capture and support-bundle paths,
and V2 failure handling needed clearer rollback/recovery semantics. Its empty
episode-scope, FTS filter-placement, and dedup-observability findings were also
accepted as lower-severity hardening rather than P0 authorization failures.

## Changes

### Auto-recall correlation self-healing

- Ambiguous weak conversation correlation now returns an explicit
  `ambiguous_correlation` outcome.
- Ambiguous entries are detached from the weak pending queue so they cannot
  poison later ordinary turns for the default 30-minute TTL.
- Entries that still have exact run/message/session aliases are preserved for
  a late exact match; unaddressable orphans are removed.
- Diagnostics record only the stable reason, never raw user query text.

### Runtime diagnostic lifecycle

- Runtime lease management now keeps an immutable healthy composition receipt.
- `start -> stop -> start` creates a new healthy lease rather than renewing the
  stopped/blocked receipt.
- Heartbeat generations are fenced so an old timer cannot overwrite a newer
  lease.

### Experience completion and promotion governance

- Mixed ACL statements are split by adversative subject scope. A protective
  clause about unauthorized users no longer hides a later failure affecting an
  authorized administrator.
- Pre-gate TaskEpisodes are explicitly counted as
  `legacy_episode_historical`. They remain fail-closed historical records and
  are not silently approved or mutated.
- This release intentionally does not add a rushed operator override path;
  future review authority must be a separate actor/reason/evidence receipt.

### Shared secret policy

- Capture safety, support-bundle inspection, and Experience transcript
  redaction now use one domain-owned secret matcher/redactor.
- Coverage includes the existing rules plus common Stripe, GitLab, Google
  OAuth, SendGrid, Twilio, AWS temporary access-key, broader GitHub/Slack/JWT,
  PuTTY key-block, and alphanumeric password-assignment forms.
- Placeholder/redacted fixtures remain usable without being treated as live
  credentials.

### Lifecycle diagnostic projection

- Lifecycle classification is maintained in a rebuildable auxiliary SQLite
  projection transactionally with SQL truth mutations.
- Dynamic `valid_from`/`invalidated_at` state is aggregated in SQL rather than
  loading and JSON-parsing the entire truth corpus in JavaScript.
- Startup backfills missing projection state; count drift triggers one bounded
  rebuild and then fails closed if truth and projection still disagree.
- The projection is diagnostic/rebuildable state and is not promoted to SQL
  authority.

### V2 failure semantics

- Truth V2 rollback now preserves the original transaction error when
  `ROLLBACK` itself fails.
- Append-delta apply checks the compatibility-backfill tables before planning
  and returns a directed prerequisite error.
- Initial V2 rollout performs convergence, integrity, and foreign-key checks
  before commit.
- A post-commit failure now emits
  `CLAWLORE_V2_POST_COMMIT_RECOVERY_REQUIRED` and requires restoring the
  verified encrypted snapshot to a new location before retry. It does not
  pretend an in-place automatic rollback exists without a supplied snapshot.

### Additional accepted static hardening

- An explicitly empty episode scope now fails closed, while a valid shared
  scope uses the same `scope_id OR shared_scope_id` visibility contract as
  other Experience reads.
- Playbook FTS applies scope/status/task filters inside the FTS join before
  ranking and `LIMIT`, preventing inaccessible top hits from starving an
  accessible result.
- Manual memory writes remain fail-open when the vector duplicate precheck is
  unavailable, but durable metadata and the tool result now record
  `dedup_skipped=true` instead of implying that the precheck ran.

## Verification

- Focused regression groups: 30/30, 28/28, 5/5, 15/15, and 39/39 passed.
- Full Linux suite: 491 total, 489 passed, 0 failed, 2 Windows-only skips.
- Strict TypeScript typecheck: passed.
- Build: passed; tracked `dist` rebuilt from source.
- Vector repair smoke: passed.
- Commercial golden: 124/124, MRR/NDCG/top-K 1, bad recall 0, cross-scope
  leakage 0.
- 200,000-row scale: FTS p95 0.043 ms, lifecycle stats 90.839 ms, known-answer
  recall 1, leakage 0.
- 1,000,000-row scale: FTS p95 0.074 ms, lifecycle stats 487.000 ms,
  known-answer recall 1, leakage 0.
- Dry-run package: 246 files; both new runtime modules and both packed smoke
  scripts are included.
- Installed tarball: runtime registration and LanceDB
  store/reopen/recall/delete/repair smokes passed.
- Isolated real OpenClaw install: `clawlore@1.2.0` loaded/enabled/activated;
  `doctor ok=true`; SQL/FTS/vector/Experience/runtime-disabled diagnostics
  passed; `clawlore`, `scope-recall`, and `memory-pro` all reported 1.2.0.
- `git diff --check`: passed.

The shell-default Node is `/opt/nodejs/bin/node` 24.14.0, which is below the
installed OpenClaw minimum. The real service uses `/usr/bin/node` 24.15.0; the
isolated OpenClaw CLI smoke therefore used that same supported interpreter.

## Remaining release blockers

- The source release gate correctly stops because package repository metadata
  names `410979729/clawlore` while `origin` still names
  `410979729/scope-recall-openclaw`.
- The worktree remains an uncommitted aggregate candidate: 72 tracked modified
  paths and 25 untracked paths after the rebuilt `dist` and this report.
- Exact Windows Node 24 validation, a new independent review of the clean
  commit, canonical remote/ref publication, and version/tag policy remain
  open.
- Any live rollout requires separate authorization plus fresh backups,
  `autoBackup:false`, an explicit legacy exact-principal allowlist or
  receipt-backed migration, final-path readiness generation, user-owned rollout
  identity, and post-restart real Telegram recall.

## Live boundary and cleanup

No live extension, OpenClaw configuration, database, service, remote, tag, or
release was changed. Candidate `dist/index.js` remains `8226bfa4...`; live is
still `95b1da2b...`, proving the remediation is not deployed.

All package-install, benchmark-database, and isolated OpenClaw state roots were
created under validated temporary paths and removed by exit traps. No tgz,
SQLite database, log, or scratch script was left in the project. The workspace
state-hygiene audit still reports the same 93 pre-existing outside-workspace
backup/session/foreign-document classifications; none was created or deleted
by this round.
