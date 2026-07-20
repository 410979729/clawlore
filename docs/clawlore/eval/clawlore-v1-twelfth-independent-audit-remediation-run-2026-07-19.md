# ClawLore 1.2.0 twelfth independent-audit remediation run

Date: 2026-07-19
Boundary: source, tests, tracked build output, and project documentation only
Result: source findings remediated; release and live deployment remain NO-GO

## Input and identity

- Independent report: `天姬-ClawLore-1.2.0-第十二次独立复审报告-20260719`.
- Branch: `feature/clawlore-identity`.
- Base HEAD: `33d164c4047da630341d26198461c4d3da2ba74e`.
- The report's standalone counterexample file was not present in the received
  attachment. Each described failure was independently reconstructed as a
  repository-owned regression instead of treating the prose as proof.
- No live extension, OpenClaw config, database, Gateway service, repository
  remote, commit, tag, push, or release was modified.

## Release blockers closed in source

### Turn-safe auto-recall correlation

Principal scope is no longer a turn alias. The cache now separates exact
run/message aliases, real session aliases, and bounded session/conversation
pending queues. A selected turn is consumed once and rebound for idempotent
retry. Session cleanup uses only exact/session aliases. If concurrent id-less
turns cannot be correlated safely, recall skips instead of guessing.

Regressions cover same-principal A/B interleaving, reverse prompt order with
exact identity, ambiguous reverse order without a shared id, retry idempotency,
session-isolated cleanup, TTL, and bounded capacity.

### Process-bound runtime diagnostic lease

The static receipt became schema v2 with a random runtime instance id, PID,
OS process-start token, heartbeat, and expiry. The running plugin refreshes the
lease every 10 seconds; it expires after 30 seconds and is immediately
invalidated on stop. Doctor fails closed for dead processes, PID reuse,
unverifiable identity, stale/future leases, binding/config mismatch, readiness
expiry, wrong hook count, writes, prompt mutation, ContextEngine registration,
or blocking reasons.

### Reviewer-gated Experience promotion

Task completion and promotion authority are independent. Episode metadata now
contains explicit `promotion_eligible`, `reviewer_passed`, and review
provenance. Automatic promotion requires an approved review receipt. Reviewer
decline, low confidence, parse failure, and capture-safety rejection remain
non-promotable even when the host task itself completed successfully.

## Should-fix findings closed

- Verified ACL/security statements such as “unauthorized users cannot access”
  are treated as protective success evidence; genuine inability to reach the
  target remains a failure.
- SQL truth statistics classify each scope into recallable, archived, and
  other inactive rows using canonical lifecycle rules. Principal-visible rows
  and legacy migration debt count recallable rows only. SQL iteration is
  streaming so doctor does not materialize the full corpus solely for this
  diagnostic.
- The live gate accepts `--principal` and `--release-ref`; operator docs define
  how to obtain the canonical principal from trusted adapter metadata. Missing
  or mismatched exact allowlists receive directed failures, and wildcard
  principals are rejected.
- Publication now requires local `HEAD` to equal the exact selected remote
  branch/tag. A reachable remote that still points at an older commit cannot
  satisfy the gate.

## Verification

- Focused blocker/should-fix regressions: pass.
- Full test suite: 482 total; 480 pass; 0 fail; 2 platform skips.
- TypeScript typecheck: pass.
- Build: pass; tracked `dist` rebuilt from the final source.
- Source governance and hotspot non-growth gates: pass.
- Vector-repair smoke: pass.
- Commercial golden: 124/124; recall/MRR/NDCG/Top-K all 1; forbidden and
  cross-scope leakage 0.
- SQLite FTS scale: 200,000 rows, 64 queries, p95 0.047 ms, known-answer recall
  1, cross-scope leakage 0.
- Final npm pack: 244 files, 499,493 bytes.
- Installed-package runtime smoke: pass.
- Installed-package LanceDB store/reopen/recall/delete/repair smoke: pass.
- `git diff --check`: pass before documentation closeout and repeated during
  final cleanup.
- Source release-gate probe: expected fail-closed at repository identity because
  package metadata names `github.com/410979729/clawlore` while `origin` still
  names `github.com/410979729/scope-recall-openclaw`.

## Live and release boundary

Final rebuilt `dist/index.js` SHA-256 is
`8226bfa4b6b0dd42afe6a0ece63095ea5160ea0455715c24aba2c6ed58f898eb`.
Live remains
`95b1da2b20424b9143bcc31575c948060d7c4ac493bcf5927c45d75238931efa`.
The mismatch proves the remediated candidate is not deployed.

The source tree remains intentionally dirty: 49 tracked modified paths and 20
untracked paths after rebuilding tracked output. A clean source+dist commit,
canonical remote ref, new independent read-only review, Windows Node 24 gate,
release evidence, and version/tag decision are still required. Any live rollout
requires separate authorization, fresh backups/readiness, an explicit legacy
principal decision, one restart, and post-restart principal-aware doctor plus
real Telegram recall.

## Cleanup

All installed-package verification trees were created under system temporary
directories and removed by exit traps. No tarball, database, temporary log,
dependency tree, or audit counterexample was added to the project. The inbound
report remains in the OpenClaw media staging area as user-provided evidence.
The state-hygiene audit still reports the same 93 pre-existing out-of-workspace
backup/session/foreign-document classifications; none was created or removed
by this source-only round.
