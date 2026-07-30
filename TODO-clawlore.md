# ClawLore v1 TODO

Updated: 2026-07-30

## 2026-07-30 runtime closure and Windows release lane

- [x] Replace the shadow-only runtime diagnostic assumptions with explicit
      disabled, shadow, v2-write, cutover, and auto-resolution contracts.
      Healthy cutover receipts no longer fail doctor merely because writes,
      prompt mutation, and the native Context Engine are intentionally active.
- [x] Delegate native Context Engine compaction to OpenClaw's stock runtime
      bridge. The engine remains non-owning, but manual and overflow-triggered
      compaction can no longer return a successful no-op.
- [x] Decouple Task Experience review from `smartExtraction`. Both features
      share one configured background LLM transport while retaining independent
      switches and diagnostics.
- [x] Raise the Windows private-file-lock stale interval to five minutes with a
      30-second refresh, covering the observed near-150-second native startup
      stall. A two-process regression proves the old 10-second takeover window
      no longer steals a healthy lock.
- [x] Make the Windows test lane use a per-run private user-profile temp root,
      discover Git for Windows when a service shell omits it from PATH, and
      mark the two POSIX-only permission suites as platform skips. The complete
      suite passes: 683 tests, 664 pass, 0 fail, 19 conditional/platform skips.
- [x] Resolve the real OpenClaw host package in both sibling Windows
      `state`/`app` and nested Linux `home/state` layouts before the expensive
      gate begins; explicit targets win and multiple inferred installs fail
      closed.
- [x] Make readiness generation follow the final configured runtime mode
      instead of hard-coding shadow. Auto mode now requires an explicit safe
      resolution; write-mode evidence fails closed; prior quality evidence is
      reusable only across the same unexpired mode, config digest, and SQL
      truth snapshot.
- [x] Restore the safe nightly-digest input path against current OpenClaw
      agent SQLite. The exact-session reader now supports `session_windows`
      as well as legacy `sessions`, and Windows database/WAL/SHM privacy checks
      verify the real DACL instead of treating mode bits as sufficient.
- [x] Replace the expiring mutable-snapshot restart trap with a durable
      write-runtime release authority. First activation and every release or
      config change still require a fresh exact truth-bound receipt; later
      restarts tolerate only normal truth drift and expiry while receipt,
      runtime, package, lockfile, config, and test bindings stay unchanged.
- [ ] Publish the clean source commit, bind new release provenance/readiness to
      that reachable commit, take fresh encrypted live snapshots, deploy with a
      reversible backup, restart once, and complete live doctor/recall/write,
      backup-maintenance, ACL, and real-channel acceptance checks.

## 2026-07-23 V2 runtime authority completion

- [x] Add a real OpenClaw native ContextEngine. It resolves exact direct-session
      principals, retrieves V2 truth, injects only active policy-approved rows,
      rejects group/unknown identity, does not ingest transcripts, and leaves
      compaction with the host.
- [x] Add readiness-gated `v2-write` and `cutover` modes. A dedicated
      `agentToolProfile: "v2-write"` exposes only the compensating
      V1-to-V2 `memory_store` path; legacy update/forget and automatic writers
      block activation so they cannot reopen parity drift.
- [x] Mirror a successful manual write into V2 revision/item/source/ACL/event,
      FTS, vector fallback, relation projection, and processed outbox state in
      one transaction. If the V2 transaction fails, delete the just-written V1
      row and return failure instead of a false success.
- [x] Add a read-only final preflight that separately reports `cutoverReady`
      and the stricter `v1RetirementReady`, covering integrity, foreign keys,
      V1/V2 mapping and content, principals, lifecycle, verification,
      projections, outbox work, and candidate disposition.
- [x] Define the final authority model: V1 is a shadow/rollback lane, V2 becomes
      authoritative at cutover, and V1 leaves normal runtime only after a
      bounded observation window and a green retirement receipt.
- [x] Promote the candidate to 1.2.3, place all prior Unreleased work under the
      release boundary, include the cutover preflight in the package, and pass
      typecheck, build, 649 tests (647 pass, 0 fail, 2 platform skips), and a
      303-file package inventory.
- [x] Correct the archived-row FTS preflight contract and rerun the complete
      release gate against final source commit
      `0f37ad1915403669398b2d309f5e28743f266707`. The final runtime digest is
      `c7a939a88afab2bf142612d9edee70136739dd5a4174a40d7c2b63147ba30317`;
      live read-only inspection reports FTS 991/991 with integrity and foreign
      keys clean.
- [ ] Production V2 activation remains a separate high-impact rollout. It
      requires controlled authorization, fresh encrypted snapshots, exact live
      principal/lifecycle/content convergence, a cutover readiness receipt,
      `plugins.slots.contextEngine: "clawlore"`, restart, real-channel
      acceptance, and a later V1-retirement observation window. The controlled
      verifier remains absent as of the final 2026-07-23 check; live blockers
      are 87 unmirrored V1 rows, 991 unresolved principals, zero active verified
      rows, 45 content divergences, and 566 undisposed candidates.

## 2026-07-22 P8 production-GO preflight

- [x] Close the candidate-side live semantic gate against the configured
      provider. The reviewed 40-positive plus 10-no-answer corpus passes
      Recall@3, Precision@3, MRR and abstention at 1.0 with 0 false positives,
      0 cross-scope leaks and 0 unsafe egress. `expected_ids` remain mandatory
      answers; two separately reviewed `relevant_ids` annotate supporting
      results without weakening ranker thresholds or negative cases.
- [x] Correct OpenClaw SecretRef discovery for the bounded embedding-key array:
      explicit leaf paths replace the object wildcard, and runtime rejects more
      entries than the manifest can safely enumerate.
- [x] Expand the secret-at-rest boundary from selected canonical tables to the
      shared V1/V2/history/FTS/projection/Experience/digest/conversation policy
      plus LanceDB. The current content-free live preflight finds 103 mirrored
      rows / 149 fields (81 unique-payload upper bound), and additionally finds
      non-owner-only SQLite companions and LanceDB tree entries. These counts
      are blockers, not 103 unique memories.
- [x] Add a digest- and identity-bound exact remediation workflow with orphan
      projection handling, three independently restored encrypted snapshots
      (memory, conversation, vector), mandatory prior credential rotation,
      whole-tree permission tightening, post-audit/integrity/FK checks and an
      explicit recovery-required failure when the vector/commit boundary has
      been crossed.
- [ ] Execute the controlled production sequence only after the registered
      secondary verifier exists and passes: disable both bypass writers, rotate
      potentially exposed credentials, take fresh three-store snapshots, apply
      a newly generated exact plan, set deprecated `autoBackup` false, deploy
      the exact candidate, restart once, run live-provider shadow/Telegram
      acceptance, and issue a GO receipt. The OpenClaw transcript remains
      read-only evidence; controlled auth stores are not ClawLore purge targets.

## 2026-07-22 P7 quality and SQLite transcript correction

- [x] Withdraw the old P5 deployment-readiness claim and supersede the P6
      `d76aec294c376863aca99c4d813085f011c6b2c1` candidate. The earlier
      1.2.1/`9d16...` line is retained below only as historical chronology.
- [x] Remove both ordinary-recall reinforcement paths: the tool does not patch
      metadata, and the retriever no longer owns or calls an access tracker for
      manual results. Only explicit journaled governance feedback may confirm
      use.
- [x] Replace BM25-as-relevance with query-to-memory lexical evidence over a
      bounded pool, preserve durable post-operation rules in the noise filter,
      and pass the unchanged 40-positive plus 10-no-answer gate at Recall@3,
      Precision@3, MRR, and abstention 1.0 with 0 false positives, 0 cross-scope
      leakage, and 0 unsafe egress.
- [x] Add an owner-only, exact-session, read-only SQLite transcript source for
      the digest CLI. It excludes arguments/results/thinking/custom events,
      fails on empty eligible input, remains dry-run by default, and does not
      change the active legacy cron.
- [ ] Keep production no-go until the content-free persisted-secret audit is
      clean, credentials are rotated, both bypass write crons are disabled,
      `autoBackup` is false, a live-provider 40+10 gate passes, and controlled
      authorization permits snapshot/purge/deploy/restart work.

## 2026-07-21 memory-quality incident — P0/P1/P2 handoff

- [x] Apply the reversible P0 runtime stop: disable auto-recall, auto-capture,
      smart extraction, Task Experience capture, memory compaction, session
      reflection/compression, and use `recallMode=off` plus
      `sessionStrategy=none`. Restart acceptance proves `smartExtraction: OFF`,
      hooks 0, writes/prompt mutation/ContextEngine false, Gateway health live,
      Telegram ingress live, and no post-restart recall/capture/truth write.
- [ ] Disable or replace two still-enabled automatic writers. The
      `nightly-conversation-extraction` cron runs at 23:00 Asia/Shanghai,
      writes `memory_truth`/FTS, and may apply vector repair. The 15-minute
      `tianji-session-pressure-guard` still invokes `--write` and can import an
      `agent:main` checkpoint if its legacy session path returns and its
      threshold is met; its current path errors are not a safety control. The
      read-only audit changed neither job. Private-chat high-impact
      configuration remains fail closed until the new controlled secondary
      verifier is configured and passed.
- [x] Complete P1 recovery baseline without changing the 1,093-row live truth:
      AES-256-GCM SQL snapshot, isolated full restore, encrypted LanceDB
      companion restore, exact post-P0 config, packed live 1.2.0 runtime, and
      body-free V1/V2 row manifests. SQL/FTS/vector are 1,093/1,093/1,093;
      integrity/FK and restored source digests pass. Evidence:
      `../../archive/clawlore-memory-p1-baseline-20260721T183346Z/`.
- [x] Complete the read-only P2 root-cause diagnosis. The current versioned
      Telegram direct principal hashes to the exact current private-user scope;
      the demonstrated drift comes from legacy/out-of-band writers that bypass
      the runtime boundary or supply `agent:main`. Focused principal, hook,
      tool, Experience, and allowlist regressions pass 56/56. Evidence:
      `../../archive/clawlore-memory-p2-principal-audit-20260721T185858Z/`.
- [x] P2 implementation: route every CLI/cron/manual/runtime writer through the
      same versioned principal resolver, remove `agent:main` as a write default,
      fail closed on unresolved identity, and prove same-user equality plus
      cross-user/conversation denial across restart and every entry point.
      Do not bypass isolation with wildcard access. `openclaw-scope-v1` is now
      the single principal boundary for runtime, CLI, cron, and manual writers;
      focused principal regressions and the full release gate pass.
- [x] P3: classify legacy provenance and prepare an exact, idempotent,
      receipt-bound migration only for records attributable to Joy. The
      isolated 1,093-row rehearsal assigns 112 rows to the exact Telegram
      principal and leaves 981 as `legacy:unresolved`; replay changes 0 rows.
      Production data remains unchanged. Evidence:
      `../../archive/clawlore-memory-p3-principal-migration-20260722T043522Z/`.
- [x] P4 source/rehearsal: quarantine irrelevant reflection and checkpoint
      recall, adjudicate duplicate/redundant content, and repair Experience
      success capture without weakening reviewer gates. The exact 112-row
      governance archive rehearsal is idempotent. A post-migration review found
      all 88 private-principal candidates to be checkpoint/reflection/runtime
      noise or canonically covered and proposes soft archive for all 88; it
      authorizes neither promotion nor live mutation. Experience focused tests
      pass 31/31 and unsafe replay admissions are 0. Evidence:
      `../../archive/clawlore-memory-p4-governance-20260722T055819Z/` and the P5
      migrated-candidate review.
- [x] P5 source/release/shadow: form a clean isolated 1.2.1 candidate, pass the
      pre-push release gate, and pass a 40-question real canonical-corpus gate.
      Commit `9d16b803bd83bde2773cb0ad304e1fedf8e4fd2b` passes 597 tests
      (595 pass, 0 fail, 2 Windows-only skips), typecheck/build, packed runtime,
      LanceDB, OpenClaw CLI, migration, SBOM, and zero-vulnerability gates.
      Real Recall@3 is 0.975, MRR 0.925, cross-scope/unsafe leakage 0. Migrated
      common-lane overlap/rank agreement are 1 with 35/35 receipt-authorized
      rewrites and 0 unauthorized drift. Evidence:
      `../../archive/clawlore-memory-p5-release-shadow-20260722T071110Z/`.
- [ ] Final live activation: after controlled authorization, disable the two
      bypass command crons, repair reviewer/embedding credentials, take a fresh
      encrypted snapshot, apply the exact principal migration and governance
      controls, deploy the clean ref, and run real live-provider shadow before
      promoting any candidate or restoring recall/capture. Current blockers are
      explicit: active V2 rows 0, injectable results 0, provider authentication
      failure, and no controlled secondary verifier in this private chat.

## 2026-07-19 live timeline and independent-audit remediation

- [x] Preserve the 11:14:24 CST guarded-rollout refusal as a distinct event.
      `clawlore-live-rollout-20260719-resume.service` ran as root, could not
      inspect the user-owned plugin path, reduced every failed status probe to
      `active_tasks=-1`, and exited at the 900-second bound before stop/swap/
      config mutation. It was not a deployment and was not replayed.
- [x] Correct the later live truth independently: a separate rollout deployed
      baseline commit `33d164c4047da630341d26198461c4d3da2ba74e` at
      14:40:35 CST. Gateway is active/running with `NRestarts=0`, healthz is
      live, runtime logs prove one registered read-only shadow hook with writes,
      prompt mutation, and ContextEngine disabled, and the old doctor reports
      1,061 SQL/FTS rows with no FTS drift.
- [x] Reproduce and fix eleventh-audit RB-1 in source: auto-recall no longer
      embeds assembled prompts, asymmetric ingress/prompt hooks share a stable
      turn boundary, repeated hooks are idempotent, and raw query previews are
      opt-in rather than default ledger content.
- [x] Reproduce and fix RB-2 in source: doctor now computes principal-visible
      rows and legacy migration debt. Default isolation remains enabled; the
      1,060 legacy `agent:main` rows require an explicit exact-principal
      allowlist or a backup/receipt-bound migration instead of a silent bypass.
- [x] Reproduce and fix RB-3 in source: runtime registration writes a private
      diagnostic receipt, doctor and release gate consume the same receipt,
      shadow requires exactly one read-only hook and zero blocking reasons, and
      readiness generation rejects any output that is not already the final
      absolute configured pointer.
- [x] Close SF-1/SF-2/SF-3 in source: abandoned-session/reflection caches now
      have TTL/LRU/hard caps and eviction metrics; task completion uses
      sentence-aware positive/negative evidence; `autoBackup` is documented as
      a deprecated no-op and `true` becomes a doctor issue rather than a false
      backup promise.
- [x] Add release repository identity controls. The gate requires package
      metadata and `origin` to name the same canonical repository. The twelfth
      remediation further requires local `HEAD` to equal an explicit remote
      release branch/tag, so a reachable but stale remote cannot pass.
- [x] Build and validate the remediated source: 467 tests / 465 pass / 0 fail /
      2 platform skips; typecheck and build pass; vector-repair smoke passes;
      commercial golden recall is 124/124 with zero scope leakage; 200,000-row
      FTS known-answer recall is 1 with p95 0.069 ms; installed-package runtime
      and LanceDB smokes pass.

### Twelfth independent review remediation (source only)

- [x] Close RB-1 without reintroducing principal-as-turn identity. Exact
      run/message aliases bind one turn; real session/conversation queues are
      bounded and consumed once; principal scope is only a correlation hint.
      If two id-less turns are concurrently ambiguous, auto-recall skips rather
      than attaching the wrong query. Session cleanup cannot traverse a
      principal hint into another session.
- [x] Close RB-2 with a process-bound short lease. Runtime receipts carry a
      random instance id, PID plus OS process-start token, a 10-second heartbeat
      and a 30-second expiry. Doctor rejects dead, reused, unverifiable, expired,
      or config/readiness-mismatched instances; plugin stop immediately writes
      an invalidated receipt.
- [x] Close RB-3 by separating task success from promotion authority. Task
      episodes now persist `promotion_eligible`, `reviewer_passed`, and explicit
      review provenance. Automatic promotion requires a positive reviewer
      decision; decline, low-confidence, parse-failure, and capture-safety
      outcomes remain non-promotable even when the task itself succeeded.
- [x] Close SF-1/SF-2. Protective ACL/security success statements no longer
      look like task failures. SQL truth stats classify recallable, archived,
      and other inactive rows with canonical lifecycle rules; visible rows and
      legacy migration debt count recallable rows only.
- [x] Close SF-3/SF-4. Live release accepts explicit `--principal` and
      `--release-ref`; exact allowlist omissions/mismatches receive directed
      failures. Local release commit must already be published at the selected
      `refs/heads/*` or `refs/tags/*` target.
- [x] Rebuild and validate the twelfth-remediation source: 482 tests / 480 pass /
      0 fail / 2 platform skips; strict typecheck/build and vector-repair smoke
      pass; commercial golden recall is 124/124 with no leakage; 200,000-row
      FTS p95 is 0.047 ms with recall 1; final pack is 244 files and the
      installed-package runtime/LanceDB smokes pass.

### Thirteenth independent review remediation (source only)

- [x] Close the new auto-recall blocker. An ambiguous id-less A/B pair now
      detaches from the weak pending queue after a safe skip, so later turn C
      recovers immediately; exact run/message aliases remain available for a
      late exact match and no raw query text enters diagnostics.
- [x] Close the runtime and ACL lifecycle regressions. Runtime
      `start -> stop -> start` rebuilds a healthy lease from immutable
      composition truth with generation-fenced heartbeats. Mixed protective
      ACL plus authorized-user failure statements are classified as failure in
      both English and Chinese.
- [x] Unify capture, support-bundle, and Experience transcript secret handling
      behind one domain policy. Add common provider/token/key formats without
      treating placeholders as credentials.
- [x] Replace full-table lifecycle metadata parsing with a rebuildable,
      transactionally maintained SQLite projection and SQL aggregation.
      Measured lifecycle stats are 90.839 ms at 200,000 rows and 487.000 ms at
      1,000,000 rows, with recall 1 and zero cross-scope leakage.
- [x] Keep old TaskEpisodes fail-closed as explicitly counted historical
      records. Do not silently approve them or invent an unaudited override
      path in this release.
- [x] Harden V2 failure boundaries: preserve the original rollback error,
      require compatibility tables before append apply, verify convergence and
      integrity before commit, and emit a directed encrypted-snapshot recovery
      contract for post-commit failures.
- [x] Close accepted static hardening: explicit empty episode scope fails
      closed; shared episode visibility is symmetric; playbook FTS applies ACL
      filters before rank/limit; fail-open memory dedup records
      `dedup_skipped=true` when its vector precheck is unavailable.
- [x] Rebuild and validate the thirteenth-remediation source: 491 tests / 489
      pass / 0 fail / 2 Windows-only skips; typecheck, build, vector repair,
      124/124 golden, 200K and 1M scale gates, 246-file pack, installed runtime/
      LanceDB, and isolated real OpenClaw load/doctor/three-command smokes pass.
      Full evidence is in
      `docs/clawlore/eval/clawlore-v1-thirteenth-independent-audit-remediation-run-2026-07-19.md`.

### Fourteenth independent review remediation (source only)

- [x] Close RB-1 by scanning every secret-pattern match and exempting only
      whole placeholder tokens. Capture, Experience, shared redaction, and
      nested support bundles now agree on placeholder-first, secret-first,
      multi-secret, and embedded-placeholder-word cases.
- [x] Close RB-2 by synchronizing candidate promotion, forgetting,
      governance cleanup/rollback, and legacy hygiene migration with lifecycle
      projection inside the same SQLite transaction. Fault injection proves
      truth/projection/audit rollback together, and a static DML allowlist
      prevents new unsynchronized mutation owners.
- [x] Close SF-1/SF-2/SF-3. ACL fallback recognizes conjunction subject
      switches; projection table/state/index recover as one versioned schema;
      ordinary reopen plus stats/doctor report revision drift without writes;
      explicit
      `repair-lifecycle-projection` is dry-run-first and `--apply` is the only
      repair authority.
- [x] Rebuild and validate the fourteenth-remediation source: 498 tests / 496
      pass / 0 fail / 2 Windows-only skips; 28/28 post-document governance
      regressions; typecheck/build/vector repair; golden 124/124; honest
      doctor-path scale at 200K/1M, with the million-row 1,500 ms ceiling
      explicit; 246-file pack; installed runtime/LanceDB; isolated OpenClaw
      inspect/doctor/no-write drift preview/apply repair/three-command smoke.
      Full evidence is in
      `docs/clawlore/eval/clawlore-v1-fourteenth-independent-audit-remediation-run-2026-07-19.md`.

### Sixteenth independent review remediation (source only)

- [x] Reproduce the five executable counterexamples before changing source:
      env/HTTP-header secrets escaped capture and downstream redaction;
      lifecycle health missed a same-revision derived-row mutation; and an
      unknown legitimate ACL subject was misclassified as a protective
      continuation.
- [x] Extend the single secret-policy owner with env-style credentials,
      Basic/Proxy-Authorization, and Cookie/Set-Cookie detection. Capture,
      support bundles, and task-experience transcript preparation now consume
      the same policy and preserve exact placeholder exemptions.
- [x] Version the lifecycle projection schema at v2. Each row now carries a
      CHECK-bound projection fingerprint; read-only health inspection reports
      `row_projection_mismatch`, and only the explicit repair path rebuilds a
      stale projection.
- [x] Replace the finite ACL-subject fallback with a bounded grammatical
      subject-shift check. Unrecognized legitimate subjects such as employees,
      paying customers, ordinary staff, and 普通员工 are no longer hidden, while
      chained denials for the original unauthorized subject remain protective.
- [x] Pass the remediated Linux gates: 43/43 focused, 502 total / 500 pass /
      0 fail / 2 platform skips, strict typecheck/build, architecture and
      lifecycle governance suites, and the 200,000-row benchmark with recall
      1, leakage 0, FTS p95 0.049 ms, and lifecycle diagnostics 351.386 ms.
- [x] Re-run on the authorized Windows work computer under the same private
      user-profile TEMP/TMP contract as CI. Official portable Node 24.15.0 was
      checksum-verified; all nine changed source/test files matched Linux
      SHA-256 exactly; focused tests passed 33/33; full tests passed 493 with
      0 failures and 8 platform skips out of 501; typecheck/build passed. The
      owned isolated root was then removed and verified absent.
- [ ] Create or rename the canonical GitHub repository, update `origin`, and
      publish one clean exact ref. The source release gate intentionally stops
      at package/origin mismatch; no repository currently exists at the
      declared canonical location.
- [ ] Run a new independent read-only review against that clean remote-ref
      candidate. The successful Windows run proves the current bytes, not a
      future commit that does not yet exist.
- [ ] Keep live deployment and bulk database mutation blocked until the SATA
      fault and encrypted off-machine backup/restore gap are closed, then seek
      fresh deployment authorization. This remediation changed no live plugin,
      config, database, Gateway, or service.

Detailed evidence:
`docs/clawlore/eval/clawlore-v1-sixteenth-independent-audit-remediation-run-2026-07-20.md`.

### Seventeenth independent review remediation (source only)

- [x] Promote the review's mechanism-level counterexamples into formal tests:
      namespaced YAML/JSON credentials in ordinary support-bundle fields; a
      wrong lifecycle plus a matching row fingerprint; and ACL failures joined
      with `plus`, `as well as`, `以及`, or `加上`.
- [x] Keep one secret-policy owner and extend it to quoted/unquoted namespace
      keys with `=`/`:` forms. Capture, support bundles, and task-experience
      transcript preparation now consume the same structured/text policy.
- [x] Replace projection-self-consistency as health proof. Auxiliary schema v4
      derives expected lifecycle and validity from `memory_truth`, compares
      them field by field, and detects a fully self-consistent forged
      projection. Explicit repair remains the only rebuild authority.
- [x] Extract canonical lifecycle normalization into
      `src/lifecycle-metadata.ts`; reduce `smart-metadata.ts` from the temporary
      814-line hotspot to 694 lines and preserve source-governance boundaries.
- [x] Replace finite ACL-connector handling with clause/subject-level
      fail-closed classification. Only an unauthorized/attacker-subject denial
      is protective; a legitimate-subject denial remains a task failure.
- [x] Pass final Linux gates: 37/37 audit-focused, 12/12 structure/governance,
      506 total / 504 pass / 0 fail / 2 platform skips, typecheck, build,
      production audit with 0 vulnerabilities, 229/229 source-dist mapping,
      and the 200,000-row gate with recall 1, leakage 0, FTS p95 0.061 ms, and
      lifecycle stats 437.267 ms.
- [x] Pass the authorized Windows Node 24.14 isolated gate: candidate archive
      digest matched across machines; 30/30 audit-focused; 505 total / 497
      pass / 0 fail / 8 platform skips; typecheck/build; 229/229 source-dist
      mapping. Remove the owned Windows and local transfer roots and verify
      both absent.
- [ ] Resolve canonical repository identity, form one clean source+dist commit,
      publish an exact branch/tag, regenerate release evidence, and obtain a
      fresh independent review of those exact bytes. The release gate correctly
      stops at the current package/origin mismatch.
- [ ] Keep live rollout, V2 writes/cutover, and live data remediation outside
      this source-only round. Joy explicitly deferred the SATA/SSD hardware
      item until the planned upgrade; it is not an actionable plugin task.

Detailed evidence:
`docs/clawlore/eval/clawlore-v1-seventeenth-independent-audit-remediation-run-2026-07-20.md`.

### Eighteenth independent review remediation (source only)

- [x] Promote the review's camelCase JSON, YAML block-scalar, ordinary
      support-bundle, and complete Task Experience capture-gate
      counterexamples into formal regressions.
- [x] Add parser-backed YAML/JSON value-range redaction with one normalized
      secret-key policy for snake/kebab/dotted/namespaced/camelCase keys,
      quoted values, and block scalars. Keep capture safety, support bundles,
      and Task Experience transcript preparation on the same owner.
- [x] Make structured task outcome the primary Experience gate: production
      capture requires a successful `agent_end`, an explicit successful
      terminal tool-result envelope, and a verified completion claim. Do not
      treat free-form stdout as structured success.
- [x] Keep clause/subject failure classification as defense in depth and reject
      `employees still have no access`, `neither can paying customers`, and
      `普通员工仍没有管理端访问权限` through the full capture gate.
- [x] Extract `src/secret-structured-text.ts` and
      `src/task-outcome-evidence.ts` as focused domain modules; reduce
      `src/task-experience.ts` from 735 to 679 lines and update architecture
      ownership/governance tests.
- [x] Pass Linux gates: 36/36 audit-focused, 8/8 structure/security, 511 total
      / 509 pass / 0 fail / 2 platform skips, typecheck, build, `git diff
      --check`, production audit with 0 vulnerabilities, 233/233 source-dist
      mapping, pack dry-run, and the 200,000-row benchmark with recall 1,
      leakage 0, FTS p95 0.050 ms, and lifecycle stats 439.119 ms.
- [x] Pass the authorized Windows Node 24.14 isolated gate on the matching
      source-input manifest: 510 total / 502 pass / 0 fail / 8 platform skips,
      typecheck, and build. Remove the exact owned Windows and local transfer
      roots and verify the Windows root absent.
- [ ] Resolve the canonical repository, correct `origin`, form one clean
      source+dist commit, publish an exact branch/tag with unique build
      identity, regenerate release evidence, and obtain a fresh independent
      review. The source gate correctly stops at package/origin mismatch.
- [ ] Keep live rollout, V2 writes/cutover, recall scope changes, Experience
      rollout, and low-confidence secret review outside this source-only
      round. They need separate read-only evidence and explicit authorization.

Detailed evidence:
`docs/clawlore/eval/clawlore-v1-eighteenth-independent-audit-remediation-run-2026-07-20.md`.

### Nineteenth self-audit remediation (source only)

- [x] Audit persistence and egress beyond the eighteenth-round entry points.
      Provider/embedding failures, CLI and support output, reflection/digest,
      governance, legacy rebuild, shadow/compaction, V2 Truth, and V2
      Experience now consume explicit shared admission, metadata, egress, and
      write policies instead of relying on caller discipline.
- [x] Make unresolved structured task failures terminal for Experience. A
      later unrelated success cannot erase them; repaired historical failures
      require explicit repair and final-verification evidence.
- [x] Close runtime state and file-privacy edges: bounded TTL ownership for
      recall/capture state, owner-only atomic files and locks, symlink/traversal
      refusal, private SQLite sidecars, and protected reflection,
      self-improvement, migration, and shadow state.
- [x] Separate V2 identifier validity from semantic write authority. Truth and
      Experience persistence now require explicit scope/state/evidence and the
      final shared persistence policy across distillation, migration, append,
      and rollout paths.
- [x] Finish the architecture non-growth pass. New responsibilities have
      focused owners, reverse-dependency debt is 29, `src/store.ts` is 2,008
      lines under its 2,010-line ceiling, and release mapping is 244/244.
- [x] Correct the supported Node 24 floor from 24.14 to 24.15. Package/lock
      engines, Linux/Windows CI, the reusable workflow, release contract,
      tests, and changelog now match OpenClaw 2026.7.1-2's
      `>=24.15.0 <25` requirement.
- [x] Pass the supported Linux Node 24.15 gates: 570 total / 568 pass / 0 fail
      / 2 skips, typecheck/build, 244/244 source-dist mapping, 0 production
      vulnerabilities, 260-file pack, recall 1, cross-scope leakage 0, and the
      complete pre-push gate from an isolated clean matching-origin checkout.
- [x] Pass the authorized isolated Windows Node 24.15 complete pre-push gate:
      569 total / 552 pass / 0 fail / 17 platform skips, typecheck/build,
      packed runtime/LanceDB/real OpenClaw/legacy smokes, 0 production
      vulnerabilities, 260-file pack, and matching Linux release/runtime/lock
      identities. Remove both owned Windows and local transfer roots and verify
      them absent.
- [x] Form one clean local source+tracked-dist candidate commit:
      `977e20375fec7cbc6be76b566c12d1ca0ffb5d77`. It includes the complete
      1.2.1 source, generated dist, tests, release contracts, and formal
      project documentation; the worktree was clean immediately afterward.
- [ ] Create or rename the canonical private `410979729/clawlore` repository
      and update `origin`. The real gate intentionally rejects the current
      legacy origin; the clean isolated pass proves the candidate rather than
      bypassing provenance.
- [ ] After canonical origin setup, run the real pre-push gate on the clean
      branch containing candidate `977e203`, push that exact branch, run the
      strict post-push evidence gate, and obtain one fresh independent review
      of that exact ref before tag/release publication.
- [ ] Keep live deployment, recall/Experience cutover, V2/data governance, and
      the low-confidence live secret review outside this source-only result.
      Each needs separate evidence and authorization; the SATA/SSD task remains
      explicitly deferred by Joy.

Detailed evidence:
`docs/clawlore/eval/clawlore-v1-nineteenth-self-audit-remediation-run-2026-07-20.md`.
- [ ] Obtain a new independent read-only review of the exact clean candidate.
      Current fixes remain a dirty source+tracked-dist worktree and are not
      deployed, committed, pushed, tagged, or released.
- [ ] Create or rename the canonical GitHub repository
      `410979729/clawlore`, then update `origin`. It does not currently exist;
      `origin` still points to `scope-recall-openclaw`, so the new source gate
      intentionally stops at repository identity before claiming release
      acceptance.
- [ ] Commit the source and tracked `dist` as one clean candidate, regenerate
      canonical evidence from that commit, run the exact Windows Node 24 and
      independent-review gates, then decide version/tag publication policy.
- [ ] Deploy the remediated candidate only under a fresh authorization. Before
      restart: capture a fresh rollback config, set deprecated `autoBackup` to
      false, choose exact legacy allowlist versus receipt-backed scope migration,
      regenerate readiness at the final configured path, and run idle/status
      probes under `User=a`/`Group=a`. Post-restart acceptance requires the new
      doctor with the intended principal, one runtime hook, health, auth/search,
      and real Telegram recall. The present valid `thinkingDefault: "ultra"`
      setting is not a current blocker.

Historical refusal archive:
`../../archive/clawlore-live-rollout-20260719_104516-resume`.

## R2 — Canonical brand and architecture convergence

Detailed plan:
`docs/clawlore/clawlore-v1-brand-architecture-refactoring-plan.md`.

- [x] Measure current source hotspots, branding debt, dependency coverage, and
      comment/compatibility markers without changing live state.
- [x] Define canonical ClawLore surfaces, explicit compatibility surfaces,
      target module boundaries, comment rules, and a phased verification ladder.
- [x] Introduce canonical `runtime` configuration while retaining
      `clawloreV2` as a deprecated, conflict-checked compatibility input.
- [x] Remove migration-era `clawlore-v2:` prefixes from current runtime logs
      and prevent unexplained new Scope Recall branding in source.
- [x] Classify every production TypeScript module and add executable non-growth
      budgets for all current hotspots plus an 800-line ceiling for new files.
- [x] Pass bundle-1 focused tests, full Node 24 Linux regression, evidence-write
      source gate, and normal-mode evidence verification on clean commits.
- [x] Extend inward dependency-direction enforcement from `src/v2` to the
      migration-era root modules, with explicit debt exceptions that can only
      shrink.
- [x] Extract configuration, reflection, capture, Markdown retrieval, runtime
      construction, and hook registration from `index.ts` under characterization
      tests; target entry point is at most 800 lines.
  - [x] Bundle 2: extract the validated plugin-config contract/parser with
        parity tests; reduce `index.ts` from 4,730 to 4,184 lines.
  - [x] Bundle 3: extract reflection contracts, transcript reading/reset
        recovery, embedded generation, and command:new/reset orchestration;
        reduce `index.ts` from 4,184 to 3,336 lines without new reverse debt.
  - [x] Bundle 4: extract auto-capture regex policy and bounded
        ingress/history conversation state; reduce `index.ts` from 3,336 to
        3,105 lines and prevent repeated identical agent-end snapshots from
        selecting the full history again.
  - [x] Extract Markdown compatibility retrieval, runtime construction, and
        capability hook registrars.
- [x] Split CLI and Agent tools by capability, centralize application policy,
      and preserve command/tool response contracts.
- [x] Reduce `MemoryStore` to a compatibility facade over explicit truth,
      projection, transaction, and retrieval ports.
- [x] Converge stable `src/v2` modules into canonical non-versioned roots one
      capability at a time; preserve actual schema/protocol version names.
- [x] Complete public-contract and security/transaction comment audit.
- [x] Pass focused/full Linux gates and all three Linux package smokes on the
      architecture-closure candidate.
- [ ] Re-run the exact Windows Node 24 gate on the future clean remote-ref
      candidate and obtain independent review before any live identity
      rollout. The 2026-07-20 dirty-candidate Windows run passed; it is not a
      substitute for clean-ref release acceptance.

Bundle-2 Linux verification: 43/43 focused tests; evidence-write and normal-mode
source gates each passed 395 total / 393 passed / 0 failed / 2 platform skips,
typecheck, build, vector repair, 124/124 recall, 200,000-row FTS, packed
runtime/LanceDB/OpenClaw CLI, 42-component SBOM, 188-file package scan, and
official-registry vulnerabilities 0. Exact Windows and independent-review
gates remain open.

Bundle-3 code candidate `799dbcf`, documentation candidate `ac5e18b`, and
evidence commit `7897a39` passed 18/18 focused tests plus evidence-write and
normal-mode Linux source gates: 403 total / 401 passed / 0 failed / 2 platform
skips, typecheck, build, vector repair, 124/124 recall, 200,000-row FTS, three
packed smokes, 42-component SBOM, 192-file pack scan, and official-registry
vulnerabilities 0. Stable release-input and runtime identities matched; bundle
3 is closed. Exact Windows and independent-review gates remain open.

Bundle-4 code candidate `95047a7`, stable plan candidate `ea82afe`, and evidence
commit `8ad0159` passed 15/15 focused tests plus evidence-write and normal-mode
Linux source gates: 411 total / 409 passed / 0 failed / 2 platform skips,
typecheck, build, vector repair, 124/124 recall, 200,000-row FTS, three packed
smokes, 42-component SBOM, 194-file pack scan, and official-registry
vulnerabilities 0. Release-input identity `3cbe4c38…` across 584 tracked inputs
and runtime identity `e25fbe07…` matched exactly; bundle 4 is closed. Exact
Windows and independent-review gates remain open.

Bundle-5 architecture closure is source-audit ready. Code candidate `d50fd4e`
reduces `index.ts` to 632 lines and `cli.ts` to 198 lines, splits memory and
Experience tools by capability, adds explicit store ports/facade, moves stable
current-product application/OpenClaw adapters to canonical roots, and shrinks
the reverse-dependency debt ledger from 45 to 44 edges. Release-gate follow-up
commits `961d2e6` and `56bce74` make the gate inspect split CLI modules and
resolve the package version from both source and compiled layouts. The final
evidence-write Linux gate passed 418 total / 416 passed / 0 failed / 2 platform
skips, typecheck, build, vector repair, 124/124 recall, 200,000-row FTS, three
packed smokes, 42-component SBOM, 239-file pack scan, and official-registry
vulnerabilities 0. Release-input identity is `6f7edcc2…` across 680 tracked
inputs; runtime identity is `40d82723…`. Exact Windows and independent review
remain open, so release/live status remains NO-GO.

Evidence commit `22f2887` repeated the same complete source gate in normal
mode. Its stable release-input and runtime identities matched exactly. R2 is
therefore closed at the independent source-audit entry boundary; it is not a
release or deployment acceptance.

An authenticated live-update request triggered a fresh rollout preflight on
candidate `c6bfb29`. The clean Linux source gate and reproducibility check
passed again; a private copy of the 1,036-row live SQLite authority migrated to
schema version 4 and reopened strictly; and an isolated state root proved the
canonical package/config staging order. The authorized Windows work computer
was offline, so the exact Windows Node 24 gate and owned audit-root cleanup
could not run. Independent review also remains open. No live extension,
configuration, database, or Gateway state changed. See
`docs/clawlore/eval/clawlore-v1-live-identity-rollout-preflight-2026-07-17.md`.

## R1 — Canonical ClawLore identity candidate

- [x] Rename product, npm package, manifest id, config root, primary CLI,
      repository metadata, default data path, and default extension to `clawlore`.
- [x] Preserve `scope-recall-openclaw` as a legacy plugin id, `scope-recall` and
      `memory-pro` as CLI aliases, old data/OAuth fallback paths, and stable
      `scope_recall_*` tool ids.
- [x] Move current design/TODO paths from `clawlore-v2` to `clawlore` and clarify
      that internal V2 names describe data architecture, not product version.
- [x] Make source/live release gates canonical, recursive, and fail-closed.
- [x] Add exact identity regressions and an audit-first migration/rollback runbook.
- [x] Pass 270/270 tests, typecheck, build, vector repair, golden recall, SBOM,
      pack scan, and the explicit source-only release gate.
- [ ] Obtain Tianxuan's independent audit on the exact committed candidate.
- [ ] Rename/create the GitHub repository and update `origin` only after the
      destination exists and the audit is accepted.
- [ ] Deploy the canonical extension/config identity only under a separately
      authorized, backup-backed rollout. Current live remains legacy-id + shadow.

### Fifth independent-audit remediation

- [x] Require a read-only validated SQL authority marker before any existing
      database schema mutation; reject zero-byte, empty, partial, corrupt, and
      marker-less zero-row files.
- [x] Make OAuth persistence same-directory atomic, fsync-backed, owner-private,
      symlink-safe, and concurrency-safe.
- [x] Validate OAuth callback state before errors, escape callback HTML, and add
      no-store/CSP/nosniff headers.
- [x] Route remaining production diagnostics through redacted summaries; make
      backup restoration the only documented migration-required recovery in
      this release.
- [x] Use bounded `hasRows()` companion probes and one POSIX/Windows file privacy
      adapter with verified ACL/mode behavior.
- [x] Pass the fresh-install exact-commit gate: 335/335 tests, typecheck/build,
      vector repair, 124-case recall, 200k FTS, official audit 0, SBOM, pack scan,
      and isolated OpenClaw inspect/doctor/three-command smoke.
- [ ] Obtain Tianxuan's acceptance of the exact fifth-remediation candidate
      before repository publication or any live identity rollout.

### Sixth independent-audit remediation

- [x] Make SQL-authority inspection validate object type and exact columns,
      keep legacy upgrade out of ordinary startup, and write the authority
      marker only after an atomic, backup-bound explicit migration succeeds.
- [x] Make Windows privacy default-deny: require the current service SID as
      owner, a protected DACL, and exactly one allow ACE for that SID; reject
      unknown owners, groups, inherited entries, and unfamiliar ACE types.
- [x] Apply the same privacy boundary to OAuth reads as writes: private parent,
      owner/mode or ACL verification, symlink refusal, `O_NOFOLLOW`, and opened
      file identity checks.
- [x] Start and await the OAuth callback listener before exposing the authorize
      URL; redact OAuth path/provider diagnostics.
- [x] Remove automatic legacy authority mutation from startup and provide an
      explicit dry-run/apply migration with verified backup and durable receipt.
- [x] Move expensive Windows ACL enforcement out of SQLite write transactions,
      private the database parent before open, and retain POSIX rollback checks.
- [x] Install the final packed tarball into an empty production directory and
      then through an isolated real OpenClaw CLI; smoke the canonical command,
      both aliases, extension activation, authority inspection, Experience
      initialization, and doctor.
- [x] Bind generated release evidence to the exact commit, runtime digest,
      pack file count, SBOM count/hash, official registry, and both packed
      runtime smokes; align package script policy and changelog.
- [x] Pass 349/349 tests and the exact clean-install source gate with
      typecheck/build, vector repair, 124-case recall, 200k FTS, official audit
      0, 42-component SBOM, 185-file pack scan, and build `dirty=false`.
- [x] Receive Tianxuan's sixth independent review of the exact delivered
      candidate. The result was NO-GO with five migration/Windows blockers;
      those findings are tracked and closed in the seventh remediation below.

### Seventh independent-audit remediation

- [x] Run Windows ACL enforcement through an encoded PowerShell command with
      structured environment input; keep paths/SIDs out of command source and
      add a real-Windows conditional integration test.
- [x] Bind SQL authority to an exact schema fingerprint covering PK/constraints,
      indexes, triggers, FTS5 definition, outbox, marker, and migration tables.
- [x] Canonicalize source/backup/receipt identities and reject all aliases,
      including relative paths, symlinked parents, source WAL/SHM, and shared
      output directories, before any write.
- [x] Make the migration backup durable with file/parent fsync, then take a
      SQLite writer lock and compare a logical snapshot digest before marker
      creation; concurrent source changes abort the migration.
- [x] Treat the internal SQLite migration receipt as commit truth and rebuild a
      missing external completed receipt idempotently after post-commit faults.
- [x] Create only missing owner-private state-directory suffixes; verify but
      never rewrite an existing parent directory or its ACL/mode.
- [x] Make release-gate entry points cross-platform Node wrappers, add a final
      packed native-LanceDB reopen/delete/repair smoke, enable strict TypeScript,
      and remove unreachable vector-first fallback branches.
- [x] Pass the exact clean code gate for `854591269632d31e03d5fc500ebdc4168d7257f4`:
      361 tests passed, 0 failed, 1 Windows-only integration skipped on Linux;
      typecheck/build/vector repair, 124-case recall, 200k FTS, official audit
      0, 42-component SBOM, 186-file pack, packed runtime/LanceDB/OpenClaw CLI
      smokes, and build `dirty=false`.
- [x] Receive Tianxuan's seventh independent review of the exact delivered
      candidate. The result was NO-GO with four authority/Windows blockers and
      six should-fix findings; remediation is tracked below.

### Eighth independent-audit remediation

- [x] Separate trusted-ancestor validation from strict private-leaf ACL
      enforcement. Accept only current-user/SYSTEM/Administrators writers on
      Windows and owner-correct non-writable ancestors on POSIX; never rewrite
      an existing ancestor.
- [x] Use writable handles for Windows backup and receipt fsync, and sync each
      atomic receipt through the same exclusive handle used to write it.
- [x] Upgrade authority to schema version 4 and reject arbitrary-name triggers,
      user-defined indexes on protected tables, and namespace views; require
      valid fixtures to pass CRUD, FTS, and durable-state characterization.
- [x] Upgrade external migration receipts to a fully bound version 3 contract
      and rebuild malformed completed receipts only from verified internal
      evidence plus the exact backup.
- [x] Preserve system `undefined` scope bypass for read tools; require an
      explicit write scope for system promote/archive calls.
- [x] Preserve compatible legacy vector-repair debt transactionally and block
      incompatible outbox contracts instead of silently dropping them.
- [x] Add Linux/Windows Node 24 CI, Node/OpenClaw/OS compatibility metadata,
      self-checking release-input evidence, toolchain/SBOM identity, and dated
      changelog structure.
- [x] Pass the Linux exact clean source gate for
      `b75e0b06e4f2701c670f114a8d1f0a25d6056250`: 379 passed, 0 failed,
      1 Windows-only skip; typecheck/build/vector repair, 124/124 recall,
      200k FTS, official audit 0, 42-component SBOM, 186-file pack, three
      packed smokes, and `dirty=false`.
- [x] Re-run the normal-mode Linux source gate at documentation commit
      `37ab56946487e15135c9f98400585386c4e69e8c`; checked-in evidence matched
      every stable field, with the declared SBOM/platform variance accepted.
- [x] Close the post-interruption Windows test-harness defects: every SQL-truth
      authority test now closes its store before recursive cleanup, and the
      legacy-hygiene subprocess converts its module URL with `fileURLToPath()`.
      Commit `53c6e65ef3adb125e890841d9aed25e94ccae87e` passes the focused 16/16
      regression plus the full 379/0/1 Linux suite, typecheck, and build.
- [x] Align the published OpenClaw peer floor, release-gate contract, CI host
      fixture, and regression assertions at `2026.7.1-beta.5`; the former CI
      `beta.2` fixture was below the package's declared plugin API/Gateway floor
      and correctly failed the real-host load. Commit
      `0547e7687ba3b025422aeaee49a34de6b8923428` closes the mismatch.
- [x] Generate and independently re-check canonical Linux release evidence at
      normal-mode verification commit `7b439915f562b1df23445ee496481892a68cb8fb`:
      379 passed / 0 failed / 1 Windows-only skip, 124/124 recall, 200k FTS,
      vulnerabilities 0, 42-component SBOM, 186-file pack, all three packed
      smokes, release-input digest `7809597722d215155a7a28d7380e84724ae3468e70c7b65d0cf178249364068b`,
      and runtime digest `82e894c689b7f7873c30cadbc6ab27b722eb1b7bedb897704d5e7515271e5fc5`.
- [x] Close Tianxuan's two eighth-review should-fix findings in
      `3747b8b3ed38c123eb43f0ff175aa34ef3aabcbc`: stable evidence comparison
      now covers SBOM format/spec/tool with counterexample regressions, and
      SQL authority tests guarantee store closure before recursive cleanup on
      assertion failure.
- [x] Regenerate and verify canonical evidence at
      `da16172ce49da5c5ef53d2865b1200ac1b33eaf8`: 382 total / 381 passed /
      0 failed / 1 Windows-only skip, 124/124 recall, 200k FTS,
      vulnerabilities 0, 42-component SBOM, 186-file pack, and three packed
      smokes. Release-input digest is
      `e35ca201ea90dfd1d11b0cc741b27b017664689aa6b49049006aa6528544f6b1`;
      runtime digest remains
      `82e894c689b7f7873c30cadbc6ab27b722eb1b7bedb897704d5e7515271e5fc5`.
- [x] Complete Tianxuan's eighth independent read-only review and focused
      follow-up. Both P2 findings are CLOSED, no new source blocker was found,
      and the final worktree remained clean at `da16172ce49da5c5ef53d2865b1200ac1b33eaf8`.
      The review verdict remains NO-GO solely because the external Windows
      gate and owned-directory cleanup below are unfinished.
- [x] Close the additional defects exposed by the isolated real-Windows run:
      Windows DACL-aware trace validation, SQLite/MemoryStore closure before
      recursive cleanup, LF-stable runtime output/manifests, and shell-free
      invocation of the exact npm CLI used by the release gate.
- [x] Close Tianxuan's post-Windows P1 findings. Commit
      `70c07ebd207146f86241cfbbbad929b518bb0e4d` hashes canonical `HEAD` Git
      blobs instead of platform working-tree bytes. Commit
      `fc8e5c23d1460a4ceb3c93d5548f2747a9a75624` verifies the trusted parent,
      opens without following symlinks, binds pre/open/post identity, and
      reads the trace through that same private handle.
- [x] Generate and verify canonical evidence at independently audited source/
      evidence HEAD `df0f80e3105bc6101a6fd78d0eb11a49983390cf`:
      both Linux gates passed 385 total / 383 passed / 0 failed / 2 platform
      skips, 124/124 recall, 200k FTS, vulnerabilities 0, 42-component SBOM,
      186-file pack, and all three packed smokes. Git-blob v2 release-input
      digest is `4fb40d68eba161e1f20c53f228a16587d1dee3449d6d13e2030c4b8b534e9f11`
      across 559 files; runtime digest is
      `ae1892b1622eacc9db7c207179444696abc8274bc464e79d440af27a6e9cb4a1`.
- [x] Receive Tianxuan's exact `df0f80e` focused closure. Both P1 findings and
      exact-candidate provenance are CLOSED; source/material verdict is GO.
      One non-blocking P3 remains: a failed same-inode mode race can report the
      pre-open mode even though the private read still fails closed.
- [ ] Pass the same final source gate on the authorized real Windows Node 24
      client at exact current source/evidence candidate `df0f80e`. An earlier
      candidate reached 382 total / 374 passed / 0 failed / 8 Windows skips,
      typecheck, vector-repair, build, 124/124 recall, 200k FTS, byte-identical
      runtime identity, and packed runtime/LanceDB smokes before an npm-audit
      transport failure; the audit child-process defect was fixed and its
      standalone Windows check returned vulnerabilities 0. A later full run
      lost SSH before returning a final exit code. None of those partial runs
      is accepted as the exact `df0f80e` Windows gate.
- [ ] Remove only the clearly owned Windows audit roots after the client is
      reachable, then verify each path is absent. Do not touch user-owned or
      ownership-unclear files.

## ClawLore v1 production hardening — active after Phase 9

The original migration roadmap closed with `no_cutover`. Independent audit
found production blockers, now tracked in
`docs/clawlore/clawlore-v1-production-hardening-plan.md`.

### H1 — Mutation authorization and diagnostic privacy

- [x] Route Agent facade correct/forget through unified address policy.
- [x] Deny cross-conversation, cross-thread, and cross-project mutations.
- [x] Preserve candidate/observed lifecycle during correction.
- [x] Deny correction of archived/superseded/purged memory without restore authority.
- [x] Redact default digest health output to status/count/timestamp fields.
- [x] Add focused adversarial regressions; 8/8 and typecheck pass.
- [x] Pass full regression/build/release gates after the complete hardening bundle.

### H2 — Enforceable SQL integrity

- [x] Define persistent item identity/tombstone semantics for purge audit/outbox.
- [x] Add real foreign keys and explicit delete behavior.
- [x] Add existing-database preview/apply/postcheck migration controls.
- [x] Prove orphan inserts fail and constrained foreign-key checks are meaningful.

H2 verification: live read-only preview found no migration blockers across
1005 items and the current revision/source/ACL/relation/event/outbox corpus;
full tests 260/260, typecheck, build, and diff check pass. Live apply remains an
H5 deployment action and has not been authorized by this code-phase result.

### H3 — Native retrieval shadow and resource bounds

- [x] Implement a real V2 truth/FTS/vector shadow retriever.
- [x] Dual-run V1 and V2 without prompt mutation or writes.
- [x] Propagate cancellation and enforce concurrency/deduplication limits.
- [x] Add divergence/latency/scope regressions and redacted trace evidence.

H3 verification: focused 19/19 and full 265/265 pass with typecheck, build,
and diff check. Live read-only smoke emits no content and returns zero V2
candidates because current migrated rows retain legacy unresolved-principal
debt; policy denial is therefore the expected safe outcome. V1 remains a
comparison/fallback lane and no prompt mutation, write, or cutover is enabled.

### H4 — Reproducible release identity

- [x] Make missing live extension fail closed outside explicit source-only mode.
- [x] Compare recursive runtime artifacts by manifest and SHA-256.
- [x] Add build/commit identity independent of SemVer.
- [x] Commit lockfile and prove clean `npm ci`/pack/SBOM reproducibility.

### H5 — Recovery, soak, deployment, and fresh decision

- [x] Run encrypted snapshot restore and constrained integrity verification.
- [x] Deploy with external rollback backup and exact artifact identity.
- [x] Run real-channel shadow probes and bounded soak.
- [x] Issue a fresh cutover-or-no-cutover receipt from current live evidence.

H5 verification: the 2026-07-14 H5 deployment loaded exact build `71e1659`,
passed 267/267 tests, live gate, schema-v3 checks, shadow probes, and soak, then
issued a fresh `no_cutover` receipt. The R1 identity candidate is a later source
change and has intentionally not replaced that live artifact before audit.

## Phase 0

- [x] Import Tianji live 1.1.0 into an isolated local Git baseline.
- [x] Record RFC, migration plan, and ADR-001 through ADR-009.
- [x] Implement Memory Address V2 types and validation.
- [x] Implement Identity Resolver and policy decision pure functions.
- [x] Implement read-only legacy address mapping preview.
- [x] Add fixtures, tests, and JSON smoke command.
- [x] Run typecheck, focused tests, full tests, build, and smoke.
- [x] Write the run report and update workspace project/day handoff.

## Phase 1A — ContextPack shadow spine

- [x] Define the ContextPack V1 schema and one compatibility Context Composer.
- [x] Add runtime `senderId` evidence to a shadow adapter without changing recall.
- [x] Fail closed before retrieval when identity/policy preflight is unresolved.
- [x] Apply lifecycle, verification, reviewed-playbook, policy, and one token budget.
- [x] Add fixtures, focused tests, JSON smoke, and a dated run report.
- [x] Run typecheck, full regression, build, old/new smokes, golden recall, and release gate.

## Phase 1B — Legacy source shadow comparison

- [x] Adapt the three current prompt producers into read-only composer sources.
- [x] Add deterministic legacy-vs-ContextPack shadow comparison fixtures/traces.
- [x] Preserve legacy identity debt and reject ambiguous private rows.
- [x] Demote reflection rules to untrusted data and require reviewed playbooks.
- [x] Add six focused tests and a machine-readable JSON smoke.
- [x] Run full regression, typecheck, build, old/new smokes, golden recall, and release gate.

## Phase 1C — 1.x safety hardening

- [x] Declare plugin SecretRef contracts without copying credential values.
- [x] Disable plaintext JSONL auto-backup and destructive startup compaction.
- [x] Hide management tools behind explicit operator gates.
- [x] Keep only read-only playbook search/inspect/preflight discoverable by default.

## Phase 2A — Truth/runtime spine

- [x] Add a default-off, redacted runtime shadow trace without replacing hooks.
- [x] Add revision/source/ACL/event/outbox Truth V2 transactions.
- [x] Add read-only legacy migration preview with verification debt.
- [x] Add one unified distillation admission path and retryable projection worker.
- [x] Add four-action Agent facade over the shared Truth V2 service.
- [x] Filter private/conversation/project access in SQL before returning rows.
- [x] Deny ungranted team/global rows and expired rows by default.
- [x] Add compatibility-first ContextEngine capability negotiation skeleton.
- [x] Align the release gate with the reduced Experience discoverability contract.

## Next slice candidates

- [x] Add online SQLite snapshot backup, restore-to-new-location verification, and rollback drill.
- [x] Add additive v2 migration apply/rollback against copied fixtures; never the live database.
- [x] Adapt legacy auto-capture/reflection/digest/task-experience triggers to one candidate journal.
- [x] Add correction/forget projection convergence receipts and operator inspection.
- [x] Add encrypted archive wrapping and key-provider integration around verified snapshots.

## Phase 2B — Module boundaries and verified snapshot

- [x] Introduce a `TruthStoreV2Port`; application services no longer import the
      concrete SQLite adapter.
- [x] Define module ownership and preserve SQL/FTS/vector/relations/Experience
      as separate capabilities.
- [x] Add an executable module-boundary test.
- [x] Repair the existing OpenClaw adapter -> migration reverse dependency.
- [x] Create online SQLite snapshots while the source store remains open.
- [x] Verify checksum, schema, integrity, foreign keys, and truth-table counts.
- [x] Restore only to a new location and remove failed restore destinations.
- [x] Reject tampered snapshots before restore.

## Phase 2C — Legacy migration drill

- [x] Require a read-only migration plan and stable digest before apply.
- [x] Require the exact plan digest and a destination that does not exist.
- [x] Preserve manual/user-confirmed rows as active only when identity resolves.
- [x] Preserve ambiguous/auto-extracted rows as unverified candidates.
- [x] Preserve archived/rejected/superseded legacy rows as non-active.
- [x] Record legacy classification, scope, identity review, and verification debt
      as source evidence.
- [x] Write a 0600 migration marker and require its id/digest for rollback.
- [x] Prove the legacy SQLite hash is unchanged before/after preview, apply, and rollback.

## Phase 2D — Encrypted snapshot archive

- [x] Wrap verified online snapshots with AES-256-GCM.
- [x] Resolve archive keys through a file SecretRef-style provider.
- [x] Reject group/other-readable key files and write archives as 0600.
- [x] Verify outer archive checksum and inner SQLite integrity before restore.
- [x] Restore only to a new location.
- [x] Remove plaintext SQLite, WAL, and SHM temporary files on all paths.

## Phase 2E — Projection convergence receipts

- [x] Return typed FTS/vector/relations projection handles from mutations.
- [x] Inspect exact outbox rows without exposing memory content.
- [x] Distinguish pending, retrying, processed, and missing states.
- [x] Claim convergence only when all expected projections are processed.
- [x] Prove correction retry and forget deletion convergence in fixtures.

## Phase 3A — Unified legacy trigger journal

- [x] Adapt auto-capture, reflection, digest, and task experience to one event contract.
- [x] Generate deterministic ids and preserve explicit provenance ids.
- [x] Prevent trigger adapters from writing any store directly.
- [x] Route all automatic events through one journal, admission, and outbox path.
- [x] Keep all automatic outputs candidate-only, including tool-verified episodes.

## Phase 4A — Read-only Memory Center model

- [x] Add a read-only application model over Truth V2 instead of a second UI store.
- [x] Expose ACL-filtered knowledge, used-this-turn, provenance, review inbox,
      corrections, current conflicts/stale facts, scope counts, projection health,
      provider egress declarations, and product capabilities.
- [x] Reuse the storage ACL predicate for memories, events, relations, and outbox health.
- [x] Reject ContextPacks whose actor differs from the Memory Center actor.
- [x] Suppress inaccessible ContextPack items and historical-revision conflicts.
- [x] Keep backup/export/playbook operations descriptive and read-only in this slice.

## Phase 5A — Subagent and Experience lifecycle

- [x] Add separate domain, application port/service, SQLite adapter, and OpenClaw adapter modules.
- [x] Implement isolated snapshots with explicitly authorized non-private context only.
- [x] Implement fork snapshots as read-only copies of the bounded parent ContextPack.
- [x] Deny child durable writes; keep safe scratch candidate-only and ephemeral/working.
- [x] Atomically revoke a snapshot while creating the child episode candidate.
- [x] Require parent ownership, successful outcome, receipts, and evidence for parent verification.
- [x] Require parent/actor ownership before episodes can seed a playbook candidate.
- [x] Prevent single-run promotion unless a separate operator review is explicit.
- [x] Add promoted/quarantined/superseded playbook lineage and negative-feedback quarantine.
- [x] Add replay quality gates for scope, tools, prerequisites, steps, verification, and disabled steps.

## Phase 6A — Compatibility and release readiness

- [x] Freeze package, manifest, config root, CLI aliases, data path, and source metadata compatibility.
- [x] Define stable release-readiness and rollout-preview response schemas.
- [x] Require mode-specific evidence for shadow, V2 write, and cutover previews.
- [x] Keep every non-disabled rollout subject to mode-specific readiness evidence and bounded plans.
- [x] Make shadow read-only and require snapshot/migration/rollback/hash gates before writes or cutover.
- [x] Add recursively redacted support-bundle output for credentials, authorization, private keys, and local paths.

## Phase 6B — Default-off runtime composition

- [x] Add an isolated `clawloreV2` schema request with `disabled` as the default.
- [x] Require a matching release-readiness receipt before shadow registration.
- [x] Register exactly one low-priority `before_prompt_build` observer in ready fixture shadow mode.
- [x] Keep Agent tools, writes, prompt mutation, and ContextEngine registration at zero.
- [x] Hash runtime trace ids and retain only the existing redacted shadow receipt.
- [x] Fail open on retrieval timeout or trace-sink failure so memory observation cannot block ordinary replies.
- [x] Reject native ContextEngine activation even when the fixture host advertises all capabilities.
- [x] Add five focused tests and a machine-readable fixture-host smoke.

## Phase 6C — Live read-only shadow acceptance

- [x] Integrate the approved composition root into the live plugin without
      enabling V2 writes, prompt mutation, or ContextEngine.
- [x] Replace the plugin-bound-only `inbound_claim` observer with the generic
      `message_received` ingress and preserve direct/group scope boundaries.
- [x] Deploy matching source/dist artifacts and verify their hashes against the
      isolated release candidate.
- [x] Verify the live Gateway, health endpoint, runtime registration receipt,
      redacted trace permissions, and zero V2 tables.
- [x] Prove one real Joy Telegram direct message passes identity and policy and
      invokes retrieval without injecting or writing anything.
- [x] Re-run the 149-test suite, typecheck, build, runtime/module/vector smokes,
      golden recall, and release gate.

## Phase 6D — Read-only observation window

- [x] Add a zero-write JSONL observation auditor that enforces private file
      permissions, rejects unexpected/raw-payload fields, and reports redacted
      identity/policy/retrieval/candidate aggregates.
- [x] Collect additional real direct-message shadow traces and verify stable
      identity/policy decisions, bounded candidate counts, and fail-open replies.
- [x] Exercise one authorized group-message boundary and prove it cannot acquire
      private-principal visibility.
- [x] Add a redacted observation summary and explicit go/no-go receipt for the
      separately approved V2-write phase.

## Phase 7 — Bounded V2 write migration

- [x] Create and verify a live encrypted snapshot before any schema change.
- [x] Run the migration preview against a verified copy and adjudicate identity
      and scope debt before apply.
- [x] Create a fresh evidence-bound V2-write readiness receipt and bind the
      executor to its exact rollout id and migration-plan digest.
- [x] Apply additive V2 schema/writes with V1 fallback, then verify SQL/FTS/vector/
      relation/Experience projection convergence and rollback evidence.
- [x] Keep ContextEngine and final recall cutover disabled until a later gate.

## Phase 7A — Read-only live migration preflight

- [x] Add WAL-consistent legacy 1.x online snapshot inspection and verified
      restore-to-new-location without requiring Truth V2 tables.
- [x] Add AES-256-GCM legacy snapshot archive support with a 0600 file
      SecretRef and plaintext/WAL/SHM cleanup on all paths.
- [x] Run migration planning only against a temporary verified copy and prove
      live logical truth stayed stable during the preview.
- [x] Emit a 0600 redacted receipt that explicitly denies V2-write authority.
- [x] Split 951 live rows into source and attribution-debt review lanes.
- [x] Add registry-bound session attribution preview without reading transcript
      content; exact live coverage is 77 direct-principal rows plus 15
      conversation-boundary rows.
- [x] Adjudicate the current 383-row broad session-reference lane from registry
      metadata only: 93 trusted, 114 system-derived, 78 legacy agent aliases,
      98 opaque/quarantined, and zero unresolved session keys or conflicts.
- [x] Review the 77 manual rows without reading content for identity: preserve
      1 archived row and require operator assignment for 76; activate none.
- [x] Add a collision-safe encrypted live-snapshot executor that rejects
      existing destinations, restore-tests to a disposable path, removes all
      plaintext SQLite files, and emits a 0600 non-authorizing receipt.
- [x] Select an approved persistent SecretRef and run the executor against the
      actual live source before requesting V2-write approval.

## Phase 7B verification

- Live read-only preflight: 952 rows stable during the run; active 0, candidate
  632, archived 320; `authorizesV2Writes=false`.
- Refined session attribution: trusted private 78, conversation 15, unresolved
  session references 0, conflicting evidence 0, transcript content read false.
- Manual review: 77 total; operator identity assignment 76, archived 1,
  automatic activation 0, content read false.
- Focused attribution/encrypted workflow tests: 8/8 PASS.
- Full plugin tests: 162/162 PASS.
- Typecheck/build/module boundaries/vector repair/golden recall/release gate:
  PASS; package scan 348 files.
- Implementation commit: `3692f99`.
- Live V2 schema/writes, configuration, prompt mutation, ContextEngine, and
  Gateway were unchanged. No persistent key or encrypted live archive was
  created in this round.
- Exit live check: Gateway active/running, healthz live, port 19021 listening,
  recent warning-or-higher journal empty, and live V2 table count 0.
- Cleanup removed generated `node_modules` and the superseded v4 receipt; the
  repository is clean and only the 0600 v5 evidence receipt remains.
- State hygiene still reports the same 68 unrelated outside-workspace findings;
  none was created or modified by this bundle.

## Phase 7C — Encrypted live snapshot and readiness gate

- [x] Keep the 76 unowned manual rows candidate-only; do not infer Joy identity.
- [x] Create an independent 32-byte archive key in the 0700 state SecretRef
      area; key file mode is 0600 and key material is not logged or documented.
- [x] Create a 0600 AES-256-GCM live archive and restore-test it to a disposable
      path; source truth remained stable at 952 rows.
- [x] Verify archive checksum, schema digest, logical truth digest, SQLite
      integrity, foreign keys, and plaintext/WAL/SHM cleanup.
- [x] Bind the v5 attribution preflight and encrypted-snapshot receipt into a
      fresh 0600 V2-write readiness receipt.
- [x] Re-run the complete release gate: 162/162 tests, typecheck, build, vector
      smoke, golden recall, and 349-file package scan PASS.
- [x] Verify Gateway active/running, healthz live, port 19021 listening, recent
      warnings empty, and V2 table count still 0.
- [x] Preserve the exact historical rollout evidence; Phase 7T later removed
      the separate human-approval artifact from the executable contract.

## Phase 7D — Bounded additive live V2 write rollout

- [x] Bind the 0600 readiness receipt to the exact rollout id, implementation
      commit, V1 fallback, and explicit ContextEngine/cutover denial.
- [x] Apply Truth V2, FTS, vector-fallback, relation-projection, rollout-ledger,
      and Experience schemas in one `BEGIN IMMEDIATE` transaction.
- [x] Preserve all 952 V1 truth rows and V1 FTS/vector fallback without rewriting
      or deleting any legacy row.
- [x] Migrate 952 V2 rows as 0 active, 632 candidate, and 320 archived.
- [x] Converge 952 FTS, 952 vector-fallback, 952 relation-projection, and 2,856
      processed outbox rows with zero pending rows.
- [x] Verify SQLite integrity, foreign keys, V1 doctor, Gateway/healthz/port,
      warning logs, repository cleanliness, and owner-only rollout receipts.
- [x] Keep live runtime mode `shadow`, compatibility ContextEngine, V1 reads,
      and the existing shadow readiness pointer unchanged; no restart occurred.

## Phase 7E — Live read-only V1/V2 recall parity

- [x] Add a query-only V1/V2 corpus, FTS, vector-fallback, ranking, and policy
      parity inspector that emits no query or memory content.
- [x] Distinguish content normalization from substantive mutation; 13 rows are
      trim-only and substantive mismatches are 0.
- [x] Prove the common content/category lane has Top-K overlap and rank agreement
      1.0 across six fixed live queries.
- [x] Prove V2 forbidden-scope leakage is 0 and candidate-only rows remain
      non-injectable.
- [x] Keep shadow-read readiness separate from cutover readiness and keep every
      receipt non-authorizing.
- [x] Resolve native FTS ranking overlap below 0.8 in a fixture-only design;
      current minimum is 0.6 because the indexed fields differ.
- [x] Define and review an evidence-backed promotion policy for the 632
      candidate rows; do not bulk-promote or infer identity.
- [x] Keep ContextEngine, prompt mutation, final recall cutover, and out-of-plan
      live V2 mutations disabled.

Phase 7E verification: focused 2/2 and full 166/166 tests PASS; typecheck,
build, module boundaries, vector smoke, golden recall, and release gate PASS;
pack scan 359 files. Live decision is `shadowReadReady=true` and
`cutoverReady=false` with no shadow blockers and three cutover blockers:
no active V2 memory, no injectable V2 recall evidence, and native ranking
overlap below 0.8.

## Phase 7F — Fixture ranking compatibility and promotion policy

- [x] Reproduce the native-field mismatch in a synthetic three-lane FTS fixture.
- [x] Define a rebuildable `memory_fts_compat_v2` projection that preserves V1
      `content + metadata_text` semantics without changing canonical V2 truth.
- [x] Restrict legacy auxiliary search input to the historical eight-field
      allowlist; do not copy raw metadata or arbitrary sender/session fields.
- [x] Add an address-bound candidate review policy for private, conversation,
      project, and broad-scope evidence.
- [x] Keep automatic promotion at zero and emit only hashed ids, dispositions,
      reason codes, counts, and a plan digest.
- [x] Prove the fixture compatibility lane restores minimum overlap/rank
      agreement to 1.0 while the intentionally divergent current lane is below 0.8.
- [x] Run focused 3/3, full 169/169, typecheck, build, module, vector, golden,
      and release gates; final package scan 369 files.
- [x] Run a read-only live compatibility-backfill preview under a new rollout;
      this requires a fresh encrypted snapshot and an exact bounded plan.
- [x] Build the live 632-row candidate review plan from address-bound evidence;
      do not promote any row outside the exact-digest plan.
- [x] Keep ContextEngine, prompt mutation, final recall cutover, and out-of-plan
      live V2 mutations disabled.

## Phase 7G — Rollout plan isolation

- [x] Require a fresh encrypted snapshot, verified restore, stable source
      digest, and zero plaintext residue before either later live action.
- [x] Bind compatibility planning to exact V1/V2 row coverage, zero mapping
      mismatches, an absent destination projection, and the exact ordered
      eight-field search allowlist.
- [x] Bind promotion planning to the exact candidate-row count; reject partial
      plans and archived rows in an actionable candidate batch.
- [x] Require distinct rollout ids, modes, and plan digests for compatibility
      backfill and candidate promotion.
- [x] Prove one action's plan cannot authorize the other action or enable
      ContextEngine, prompt mutation, or final recall.
- [x] Run focused 6/6, full 172/172, typecheck, build, module, vector, golden,
      and release gates; final package scan 373 files.
- [x] Obtain exact authorization for a fresh encrypted snapshot plus two
      read-only live previews and execute it without live mutation.
- [x] Verify the compatibility preview covers V1/V2 952/952 with zero mapping
      mismatch, zero existing projection rows, and the exact eight-field allowlist.
- [x] Review the exact 632-row candidate plan: 0 eligible, 476 held, 156
      quarantined, automatic promotion 0; do not request a lifecycle rollout.
- [x] Apply only an exact-digest compatibility projection plan, if selected.
- [x] Keep ContextEngine, prompt mutation, final recall cutover, and out-of-plan
      live V2 mutations disabled.

## Phase 7H verification

- Fresh AES-256-GCM snapshot/restore: 952 stable rows, integrity ok, foreign
  keys 0, plaintext/WAL/SHM residue 0.
- Compatibility plan digest:
  `5614ec9e30b9092dc65ef91b306b3254881723f48194bdb47167bdbee8089d8a`.
- Candidate plan digest:
  `d93c590f6c1d4437d9a3a5b1da1dc86d5793b92fbc59e7648030fdbd4ae1351b`.
- Focused 8/8 and full 174/174 tests PASS; typecheck, build, module, vector,
  golden recall, and release gate PASS; package scan 378 files.
- Implementation commit: `fa7276f`.
- No compatibility object, lifecycle mutation, ContextEngine, prompt mutation,
  final recall cutover, configuration change, or Gateway restart occurred.
- Exit: repository clean, `WORKSPACE_LAYOUT_OK`; state hygiene remains the same
  68 unrelated historical outside-workspace findings.

## Phase 7I — Compatibility apply, failed acceptance, rollback, corrected plan

- [x] Add an exact-digest, 0600-approval-bound transactional compatibility
      backfill executor and focused regression tests.
- [x] Apply approved r1 as 952 projection rows while preserving V1/V2 truth,
      lifecycle 0/632/320, pending outbox 0, and all runtime cutover denials.
- [x] Reject completion after independent live FTS acceptance found minimum
      Top-K overlap 0.6 and rank agreement 0.433333.
- [x] Identify the root cause: r1 recomputed metadata from raw JSON while the
      Phase 7F compatibility contract required persisted
      `memory_truth.metadata_text`; 251 rows differed.
- [x] Roll back the rebuildable projection in one transaction and verify no
      compatibility object remains, integrity ok, foreign keys 0, and all
      canonical/lifecycle/outbox counts unchanged.
- [x] Bind the corrected plan and executor to
      `memory_truth.metadata_text`; add a historical-drift regression fixture.
- [x] Generate corrected r2 read-only preview with V1/V2 952/952, mapping
      mismatch 0, existing projection 0, and plan digest
      `ea045877e59a2b9d5afe726d75224f18b0849a4b3b746ca48175c8b391549697`.
- [x] Prove the corrected connection-local projection restores minimum live
      Top-K overlap/rank agreement to 1.0 across six fixed probes.
- [x] Run focused 7/7, full 176/176, typecheck, build, module, ranking/control,
      vector, golden, and release gates; package scan 383 files.
- [x] Execute corrected rollout
      `clawlore-v2-compatibility-backfill-20260712-r2` under the then-current
      exact-digest artifact; Phase 7T later removed that artifact requirement.
- [x] Keep lifecycle mutation, ContextEngine, prompt mutation, final recall,
      configuration changes, and service restart disabled.

## Phase 7J — Corrected compatibility backfill acceptance

- [x] Refresh the expired encrypted snapshot and verify 952 stable rows,
      integrity ok, foreign keys 0, and no plaintext/WAL/SHM residue.
- [x] Regenerate the r2 read-only preview under the same rollout id and prove
      the plan digest remains
      `ea045877e59a2b9d5afe726d75224f18b0849a4b3b746ca48175c8b391549697`.
- [x] Apply 952 compatibility rows from persisted
      `memory_truth.metadata_text` with zero canonical, lifecycle, or outbox
      changes and without copying raw metadata.
- [x] Independently verify six fixed live queries at minimum Top-K overlap 1.0
      and rank agreement 1.0; metadata-text mismatches are 0.
- [x] Fix the repeated-apply regression fixture to reuse its injected clock;
      focused 10/10 and full 176/176 tests now pass.
- [x] Pass typecheck, build, module, vector, golden recall, release gate, and a
      384-file package scan.
- [x] Verify live V1/V2 remain 952/952, lifecycle 0/632/320, pending outbox 0,
      Gateway active/running and healthz live, with unchanged config/MainPID
      and no warning logs since apply.
- [x] Preserve V1 fallback and keep lifecycle mutation, ContextEngine, prompt
      mutation, and final recall cutover disabled.

## Phase 7K — Read-only candidate evidence remediation workbench

- [x] Re-anchor the next round to the migration plan, TODO/project/day handoff,
      and the exact Phase 7H/7J candidate plan digest instead of treating
      compatibility completion as cutover authority.
- [x] Add a query-only live workbench that reads candidate metadata, V2 address
      state, source classification, and the sessions registry; it reads no
      memory text or transcript content and emits no raw identifiers.
- [x] Fail closed when the owner-only baseline preview is invalid, the current
      candidate set differs from its 632 hashed ids, or live counts change
      during planning.
- [x] Split all 632 candidates into 166 assignment-review rows, 179 source/
      receipt evidence-review rows, and 287 quarantine rows; mutation-ready and
      automatic-promotion rows remain 0.
- [x] Preserve V1 fallback and the 952-row compatibility projection; make no
      lifecycle, canonical truth, outbox, configuration, prompt, ContextEngine,
      final-recall, or service change.
- [x] Pass focused 2/2 and full 178/178 tests, typecheck, build, module,
      ranking/control, vector, golden recall, and release gate; pack 389 files.
- [x] Obtain a separate exact-plan decision before writing any identity/
      boundary evidence or changing lifecycle. The 166 assignment-review rows
      are not confirmed merely because registry evidence exists.

## Phase 7L — Exact read-only evidence-assignment plan

- [x] Map the round back to migration stage 4 and bind it to the exact Phase 7K
      remediation receipt, Phase 7H/7J promotion baseline, current candidate
      state, and owner-only sessions registry.
- [x] Add an exact, query-only planner that emits hashed item/state/evidence
      digests and resolver codes without memory text, transcript content, or
      raw principal/conversation/session identifiers.
- [x] Propose evidence assignment for exactly 76 direct-principal and 14
      conversation-boundary rows; keep 76 manual rows unassigned, hold 179
      rows for external source receipts, and retain 287 quarantine rows.
- [x] Preserve lifecycle=`candidate` and current verification for all 632 rows;
      automatic promotion and lifecycle/verification changes remain 0.
- [x] Fail closed on remediation/baseline checksum drift, registry evidence
      drift, incomplete candidate coverage, missing resolver evidence, or live
      state changes during planning.
- [x] Generate the owner-only live plan for proposed rollout
      `clawlore-v2-evidence-assignment-20260712-r1`, digest
      `0f432fad09130287181fc811e8a61cc80f42ed6d10ace7d2d3c0077b9aec4e1c`.
- [x] Pass focused 4/4, full 180/180, typecheck, build, module, ranking/control,
      vector, golden recall, and release gate; package scan 394 files.
- [x] Before any evidence write, require a fresh encrypted snapshot and a
      separate exact rollout approval. The plan itself grants no write,
      lifecycle, ContextEngine, prompt, or final-recall authority.

## Phase 7M — Approved live evidence assignment

- [x] Add an exact-plan apply operator that validates owner-only plan,
      approval, fresh encrypted snapshot, and live target evidence before
      opening a write transaction.
- [x] Treat unrelated sessions-registry additions as non-target drift while
      requiring all 632 planned rows and all 90 target resolver digests to
      remain exact; target drift fails closed before mutation.
- [x] Create and restore-verify a fresh AES-256-GCM snapshot with 952 stable
      V1 rows, integrity `ok`, foreign keys 0, and no plaintext/WAL/SHM restore
      residue.
- [x] Apply rollout `clawlore-v2-evidence-assignment-20260712-r1`, plan digest
      `0f432fad09130287181fc811e8a61cc80f42ed6d10ace7d2d3c0077b9aec4e1c`.
- [x] Write exactly 76 direct-principal and 14 conversation-boundary evidence
      payloads; change 0 manual, external-source, quarantine, or non-target
      evidence rows.
- [x] Preserve V1/V2 952/952, lifecycle 0/632/320, all verification/address
      state, compatibility 952, pending outbox 0, V1 fallback, configuration,
      ContextEngine, prompt mutation, and final recall.
- [x] Pass focused 4/4 and full 182/182 tests, typecheck, build, module,
      ranking/control, vector, golden recall, and release gate; package scan
      399 files.
- [x] Generate a new read-only post-assignment candidate plan before proposing
      any lifecycle change. Phase 7M approval cannot authorize promotion.

## Phase 7N — Post-assignment candidate-policy preview

- [x] Add a query-only planner that binds the owner-only Phase 7L exact plan to
      the Phase 7M acceptance receipt and validates all 90 assigned evidence
      payloads against their approved per-row digests.
- [x] Interpret direct-principal and conversation-boundary evidence without
      inferring a principal/conversation id or changing address/verification.
- [x] Keep the exact 632-row V2 candidate baseline fail-closed while tolerating
      unrelated append-only V1 rows and reporting them as a cutover blocker.
- [x] Generate the owner-only live preview for proposed rollout
      `clawlore-v2-candidate-promotion-20260712-r2`, plan digest
      `b4f93105e76db3d639ef8d797dca327e6490375d6ba1018a88077ddbb600e74a`.
- [x] Confirm 0 eligible, 476 hold, 156 quarantine, automatic promotion 0;
      lifecycle rollout is not selectable and no approval should be requested.
- [x] Record V1/V2 979/952 with 27 append-only V1 rows not yet mirrored to V2;
      candidate baseline, compatibility 952, and pending outbox 0 remain stable.
- [x] Pass focused 4/4 and full 186/186 tests, typecheck, build, module,
      ranking/control, vector, golden recall, and release gate; pack 404 files.
- [x] Preserve all live evidence/lifecycle/verification/address/config/runtime
      state and keep V1 fallback, ContextEngine, prompt, and final recall unchanged.

## Phase 7O — Append-only V1 delta migration preview

- [x] Add an owner-only, query-only delta planner bound to the Phase 7N
      candidate receipt; emit hashes/counts only and never memory content or raw ids.
- [x] Keep the existing 952 V2 rows and exact 632-row candidate baseline fixed;
      reject any V2 row that loses its legacy backing.
- [x] Classify the 27 append-only V1 rows as 27 reflection summaries, 27
      unverified, 27 legacy-identity debt, and 27 operator-review required.
- [x] Propose 0 active / 27 candidate / 0 archived rows; legacy metadata state
      `active` does not override unresolved identity and verification debt.
- [x] Plan 27 Truth/compatibility/FTS/vector/relation rows and 81 processed
      outbox projection receipts under rollout
      `clawlore-v2-v1-delta-migration-20260712-r1`.
- [x] Generate owner-only plan digest
      `28957730237f1b4a272cd1a103c1114db30411f153e6bc21fd01aa49afd0ac1a`.
- [x] Pass focused 3/3 and full 189/189 tests, typecheck, build, module,
      ranking/control, vector, golden recall, and release gate; pack 409 files.
- [x] Before the historical delta write, require a fresh encrypted snapshot and
      an exact reproduced plan. Phase 7Q completed the write; Phase 7T later
      removed the separate human-approval artifact without weakening those
      machine controls. The preview itself authorized no write or cutover.

## Phase 7P — Exact-approval drift rejection and delta apply gate

- [x] Add an exact-digest delta apply operator and CLI that require owner-only
      plan/approval controls plus a fresh encrypted snapshot before mutation.
- [x] Protect all existing canonical, lifecycle, verification, source-evidence,
      ACL, and event rows with pre/post transaction digests.
- [x] Atomically bind later approved rows to Truth, compatibility/current FTS,
      vector fallback, relation projection, and processed outbox convergence.
- [x] Fail closed on the approved 27-row plan because live V1 grew to 980 and
      the delta changed to 28 rows before snapshot or write.
- [x] Generate a new owner-only read-only plan: 27 reflection summaries plus 1
      operational checkpoint, all candidate/unverified/legacy-identity debt;
      rollout `clawlore-v2-v1-delta-migration-20260712-r2`, digest
      `6f1e6ac9764dc3e2e5fd7796075a360696ae484f7b308b6d1fa2cfa59b421d35`.
- [x] Pass focused 6/6 and full 192/192 tests, typecheck, build, module,
      ranking/control, vector, golden recall, and release gate; pack 414 files.
- [x] Preserve live V2 952, lifecycle 0/632/320, all projections 952, pending
      outbox 0, V1 fallback, ContextEngine, prompt, and final recall boundaries.
- [x] Obtain a new exact r2 approval for the 28-row plan before creating a fresh
      encrypted snapshot or running the delta apply operator.

## Phase 7Q — Approved 28-row append-only delta apply

- [x] Recompute the live plan with the exact Phase 7P defaults and reproduce
      digest `6f1e6ac9764dc3e2e5fd7796075a360696ae484f7b308b6d1fa2cfa59b421d35`.
- [x] Reject an initial wrong-workspace parameter check before snapshot or
      mutation; remove its temporary receipts during cleanup.
- [x] Create and restore-verify a fresh AES-256-GCM snapshot with V1 980,
      integrity `ok`, foreign keys 0, and no plaintext/WAL/SHM residue.
- [x] Append exactly 27 reflection summaries and 1 operational checkpoint as
      candidate/unverified/legacy-identity-debt rows.
- [x] Preserve all existing canonical/lifecycle/verification/evidence state;
      existing-row changes are 0.
- [x] Converge compatibility/current FTS/vector/relation projections to 980
      each and add exactly 84 processed outbox receipts with pending 0.
- [x] Independently verify V1/V2 980/980, lifecycle 0/660/320, SQL integrity,
      foreign keys, rollout ledger, V1 doctor, and SQL/vector scope parity.
- [x] Pass focused 6/6 and full 192/192 tests, typecheck, build, module,
      ranking/control, vector, golden recall, and release gate; pack 415 files.
- [x] Keep V1 fallback enabled and lifecycle mutation, ContextEngine, prompt
      mutation, final recall, configuration changes, and service restart off.
- [x] Generate a new read-only 660-candidate policy/evidence baseline before
      proposing any further lifecycle or cutover action.

## Phase 7R — Read-only 660-candidate policy/evidence baseline

- [x] Preserve the exact Phase 7L/7M 632-row assignment baseline and validate
      all 90 registry-resolved evidence payloads.
- [x] Require and bind the owner-only Phase 7Q acceptance before admitting the
      28 appended V2 candidates into the new baseline.
- [x] Validate the delta as 27 reflection summaries plus 1 operational
      checkpoint, all candidate/unverified/legacy-identity debt and review-required.
- [x] Verify V1/V2 and compatibility/current FTS/vector/relation projections
      are 980/980 with no missing legacy backing and pending outbox 0.
- [x] Cover all 660 candidates: 0 eligible, 504 hold, 156 quarantine,
      automatic promotion 0, lifecycle rollout not selectable.
- [x] Emit a 0600 redacted receipt with plan digest
      `64f07394910eae30e8ea4e888ec17805400682931bc293c58ac7f8c39b18dc85`.
- [x] Pass focused 6/6 and full 194/194 tests, typecheck, build, module,
      ranking/control, vector, golden recall, and release gate; pack 416 files.
- [x] Keep database/config/service/lifecycle/verification/address/runtime state
      unchanged. No lifecycle or cutover approval is useful while eligible is 0.
- [x] Generate a new read-only remediation plan over the current 504 hold and
      156 quarantine rows before proposing any evidence write.

## Phase 7S — Policy-bound remediation and one-row exact evidence plan

- [x] Preserve the Phase 7R 504 hold / 156 quarantine dispositions exactly.
- [x] Split holds into 77 assignment-review and 427 evidence-review rows;
      mutation-ready rows remain 0.
- [x] Generate an exact non-authorizing plan for 1 new registry-direct evidence
      assignment; keep 503 holds and 156 quarantines unchanged.
- [x] Pass focused 4/4, affected 8/8, full 196/196, typecheck/build/module/
      ranking/control/vector/golden/release; pack 417.
- [x] Before the evidence write, fail closed on one new append-only V1 row;
      migrate it as candidate/unverified through a fresh encrypted snapshot,
      restore V1/V2 and all projection parity at 981, and rebuild the exact
      661-candidate baseline.
- [x] Bind the original one-row target with a hashed allowlist, create a second
      fresh encrypted snapshot, and write exactly one direct-principal evidence
      row. Preserve lifecycle/verification/address and all non-target evidence.

## Phase 7T — Remove repeated human rollout approvals

- [x] Remove approval JSON parsers, approval CLI arguments, and approval receipt
      hashes from runtime shadow, migration, compatibility, V1-delta, and
      evidence-assignment execution paths; tolerate the legacy `approvalFile`
      config key as a deprecated ignored input so existing config still loads.
- [x] Keep machine-enforced readiness, exact plan digests, drift detection,
      fresh encrypted snapshots, transactional boundaries, rollback evidence,
      projection convergence, and ContextEngine/prompt/final-recall denials.
- [x] Rename the rollout ledger column to `control_sha256`; migrate the legacy
      `approval_sha256` column transactionally when a later delta apply opens it.
- [x] Keep the unrelated hard-delete confirmation boundary intact because it
      protects irreversible deletion rather than staged rollout progress.
- [x] Finish full regression, build, release gate, run report, and source-tree
      cleanup: 196/196 tests, typecheck/build, all affected smokes, golden
      recall, and release gate PASS; package scan 418 files.
- [x] Deploy the verified runtime entrypoint source, compiled entrypoint, and
      manifest to the live extension under the existing authenticated
      service-change boundary; restart once and verify a real read-only shadow
      trace without reading or requiring the deprecated approval file.
- [x] Complete the one-row Phase 7S evidence apply after fresh snapshot and
      live-drift recovery. The rebuilt allowlist-bound plan digest is
      `a642d63d04c4c281fa22a604cb4092bcd838747af89b70d7785cd2d98e2d3cd4`.

## Phase 7U — Read-only source-lineage receipt plan

- [x] Add an owner-only, query-only planner over the current 206
      `derived_system_evidence_review` rows; bind the complete 661-candidate
      remediation set and all live projection counts.
- [x] Require exact legacy source, current revision/source, rollout id, and one
      matching remembered migration event without reading or emitting memory
      or transcript content.
- [x] Treat the immutable historical `operator:approved-*` event actors as
      audit compatibility only; do not restore an executable approval gate.
- [x] Generate a 0600 live plan for exactly 206 reflection-summary lineage
      receipts, with 0 incomplete rows and 455 non-target candidates.
- [x] Keep evidence writes, lifecycle/verification mutation, ContextEngine,
      prompt mutation, and final recall disabled; no live mutation occurred.
- [x] Pass focused 2/2, full 200/200, typecheck/build/module/runtime/ranking/
      control/vector/golden/release gates; closing package scan 424 files.
- [x] Revalidate the live host after the `/goal` UX restart: Gateway
      active/running with healthz live, the same Telegram goal remains active,
      and a fresh installed-registry import exposes the Telegram progress
      placeholder. This host patch does not authorize the 206-row apply.

## Phase 7V — Transaction-scoped source-lineage apply gate

- [x] Add an owner-only executor and CLI that require the exact Phase 7U plan,
      a fresh restore-verified encrypted snapshot, and a byte-equivalent live
      plan replay before opening a write transaction.
- [x] Revalidate every target's candidate state, exact current source,
      source-evidence digest, and same-revision migration-event digest inside
      the transaction; reject duplicate receipts or multiple current sources.
- [x] Restrict the write to `sourceLineageReceiptV1`; protect all non-target
      evidence, events, canonical items, lifecycle, verification, address,
      projections, pending outbox, V1 fallback, and runtime cutover controls.
- [x] Pass focused planner/apply 4/4, full 202/202, typecheck/build/module/
      runtime/ranking/control/vector/golden/release gates; closing package scan
      429 files.
- [x] Run a live query-only replay and fail closed before snapshot/write on
      V1/V2 drift 982/981; existing source-lineage receipt rows remain 0.
- [x] Generate a separate 0600 read-only r4 plan for the one new operational
      checkpoint, digest
      `cef0b285d178bfdf0fdd27a518a184ee51ae121c4021de2ba715de31aa2c6c3a`;
      it authorizes no delta write or runtime cutover.
- [x] When Joy continued the live write, create a fresh encrypted snapshot, replay
      the exact one-row r4 delta, restore parity, then regenerate the candidate/
      remediation/source-lineage plans before considering the 206-row apply.

## Phase 7W — One-row convergence and assignment-control chain

- [x] Restore-verify a fresh encrypted 982-row V1 snapshot, then replay the
      exact r4 delta digest `cef0b285...2c6c3a` and append only one operational
      checkpoint as candidate/unverified/legacy-identity debt.
- [x] Prove V1/V2 and compatibility/current FTS/vector/relation projections
      converge at 982, pending outbox remains 0, integrity is `ok`, and existing
      canonical/lifecycle/verification/evidence changes remain 0.
- [x] Fix the post-assignment planner to validate a non-overlapping chain of
      exact assignment plan/acceptance controls. The live baseline now proves
      all 91 evidence rows across the 90-row Phase 7M and 1-row Phase 7S
      controls; an incomplete or overlapping chain fails closed.
- [x] Regenerate the 662-candidate baseline (0 eligible / 506 hold / 156
      quarantine), remediation (78 assignment / 428 evidence / 156 quarantine),
      and 206-row source-lineage plan with 0 incomplete rows. The new lineage
      digest is `6754fa858dd6c9b3ffefe312651f15de3d92d368c6e7f92d97bac474e0424c15`.
- [x] Pass focused 15/15, full 204/204, typecheck/build/module/runtime/ranking/
      control/vector/golden/release gates; closing package scan 430 files.
- [x] Keep the 206-row source-lineage apply separate until a fresh snapshot and
      exact replay authorize the evidence-only transaction. Phase 7X completed
      that bounded apply without lifecycle, verification, prompt,
      ContextEngine, or final-recall mutation.

## Phase 7X — Source-lineage live apply and remediation closure

- [x] Reproduce the 206-row Phase 7W plan byte-for-byte, create a fresh
      restore-verified encrypted snapshot, and attach exactly 206 support-only
      source-lineage receipts under one transaction.
- [x] Independently prove 206 distinct current candidate items received
      reflection-summary source receipts while non-target evidence, events,
      canonical items, lifecycle, verification, address, projections, pending
      outbox, and runtime controls changed by 0.
- [x] Close the post-apply planner state transition: structurally valid receipts
      move to `source_lineage_content_review`; invalid receipts stay fail-closed,
      and stale remediation targeting an existing receipt is rejected.
- [x] Detect a new live V1 operational checkpoint during acceptance, create a
      second fresh snapshot, replay only the exact r5 delta, and restore V1/V2
      plus all four projections to 983/983 with pending outbox 0.
- [x] Bind the 663-candidate baseline to the cumulative non-overlapping r4+r5
      delta controls. Final policy remains 0 eligible / 507 hold / 156
      quarantine; remediation is 79 assignment / 428 evidence / 156 quarantine,
      including 206 source-lineage content-review rows.
- [x] Pass focused 9/9, full 205/205, typecheck/build/module/runtime/ranking/
      control/vector/golden/release gates; closing package scan 431 files.
- [ ] Perform bounded operator content-quality review for the 206 receipts and
      the remaining assignment/evidence lanes. Do not infer promotion authority
      from source lineage and do not enable lifecycle, ContextEngine, prompt
      mutation, or final recall.

## Phase 7Y — Query-only candidate content-quality review

- [x] Add a redacted content-quality planner bound to the exact Phase 7X
      remediation, live source counts, current revision/content digests, and
      structurally valid source-lineage receipts.
- [x] Reuse capture-safety, the 4,000-character admission boundary, and exact
      normalized duplicate grouping without emitting memory text, transcript
      text, or raw identifiers.
- [x] Fix false drift caused by comparing unordered semantic state with ordinary
      JSON serialization; compare source fields explicitly and retain a live-
      order regression fixture.
- [x] Generate the mode-0600 live plan for 206 rows: 151 capture-safety reject
      review / 0 safe oversized review / 2 safe duplicate review / 53 manual
      semantic review. Independent signals include 22 duplicate rows in 9
      groups and 10 over-limit rows; mutation-ready remains 0.
- [x] Prove all 206 item/revision/content/lineage digests match live truth and
      the plan contains no raw content or raw item/revision ids. V1/V2 and all
      projections remain 983, active 0, pending outbox 0.
- [x] Pass focused 7/7, full 208/208, typecheck/build/vector/golden/runtime/
      release gates. Closing package scan is 438 files.
- [ ] Adjudicate the 151 unsafe rows, 2 safe duplicate rows, and 53 clean rows
      as separate operator batches. Any rewrite/archive/verification/lifecycle
      action requires a new exact plan and must remain isolated from runtime
      cutover.

## Phase 7Z — Query-only capture-safety operator batches

- [x] Add a fail-closed planner bound to the exact owner-only Phase 7Y plan,
      all 206 current candidate/revision/content/normalized-content/lineage
      digests, and unchanged V1/V2/projection counts.
- [x] Split the 151 unsafe operational traces into exact operator batches:
      20 exact-duplicate trace review / 7 unique oversized rewrite review /
      109 command-trace rejection review / 15 tool-payload rejection review.
- [x] Preserve overlapping signals without double counting: 10 total oversized
      rows, 20 duplicate rows, and 3 rows carrying both signals. Automatic
      archive and mutation-ready rows remain 0.
- [x] Prove the mode-0600 plan contains only hashes/review metadata, has 151
      unique live bindings and 0 mismatches, and emits no raw content or raw
      item/revision ids.
- [x] Pass focused capture-safety/content tests 6/6, full 211/211, typecheck,
      build, vector/golden/runtime/release gates. Closing package scan is 445
      files.
- [ ] Make operator decisions for the four batches. Any rejection, rewrite,
      canonical selection, archive, verification, or lifecycle apply must use
      a new exact control and cannot be inferred from this review plan.

## Phase 8A — Exact duplicate-trace adjudication

- [x] Review the 20 exact-duplicate operational-trace rows as 8 normalized
      groups against durable knowledge before proposing any disposition.
- [x] Add a fail-closed adjudicator requiring complete group decisions, safe
      evidence bases, exact Phase 7Z/live row binding, and redacted mode-0600
      query-only output.
- [x] Separate 5 groups / 14 rows already covered by durable truth or transient
      runtime state from 3 groups / 6 rows whose durable facts need bounded
      rewrite. Mutation-ready and automatic archive remain 0.
- [x] Recover one new V1 operational checkpoint only after a fresh encrypted
      snapshot and exact r6 delta. V1/V2 and all four projections are 984,
      candidate 664, active 0, archived 320, pending outbox 0.
- [x] Pass focused 11/11, full 216/216, typecheck/build/module/runtime/ranking/
      control/vector/golden/release gates. Closing package scan is 451 files.
- [ ] Produce bounded rewrites for the 6 durable rows and deduplicate the
      rewritten facts against knowledge; do not archive those rows first.
- [ ] If the 14 reversible proposals are selected for apply, create a fresh
      encrypted snapshot and a separate exact soft-archive transaction plus
      independent acceptance. Do not expand it to the other 131 unsafe rows.

## Phase 8B — Durable rewrite proposals

- [x] Deduplicate the 3 durable-fact groups against canonical knowledge: 2 are
      covered by existing ClawLore truth and 1 is materially new bounded truth.
- [x] Select one deterministic representative per exact pair and keep the
      companion candidate/unverified for post-rewrite dedupe review.
- [x] Add fail-closed proposal/payload/acceptance controls covering incomplete
      groups, unsafe prose, no-op rewrites, current-corpus collisions, duplicate
      proposals, payload tamper, live drift, and source convergence.
- [x] Generate and independently accept the 0600 live query-only plan: 3
      representatives / 3 dedupe holds / 0 collision / 0 mismatch / 0 leak /
      0 mutation-ready. Live remains 984/984 with candidate 664.
- [x] Pass focused 16/16, full 221/221, typecheck/build/module/runtime/ranking/
      control/vector/golden/release gates. Closing package scan is 459 files.
- [x] If live rewrite is selected, create a fresh encrypted snapshot and an
      exact three-representative transaction that preserves candidate/
      unverified state and leaves all three companions unchanged.
- [x] Rebuild content-quality and duplicate plans after rewrite before any
      companion soft archive; do not reuse Phase 8A/8B plans across revisions.

## Phase 8C — Exact durable rewrite live apply

- [x] Repair the continuous-append candidate-baseline comparison and cover a
      later V1-only append without weakening the unmirrored-row cutover block.
- [x] Under a fresh encrypted snapshot, migrate the exact r7 operational
      checkpoint and restore V1/V2/four projections to 985/985.
- [x] Bind the accepted Phase 8B plan, payload, acceptance, post-r7 candidate
      baseline, and a second fresh encrypted snapshot into one exact three-row
      durable rewrite transaction.
- [x] Create 3 new candidate/unverified representative revisions while keeping
      all 3 companions, current lifecycle/verification, address, ACL, V1,
      compatibility/vector/relation projections, outbox, and runtime gates
      unchanged. Independent postcheck mismatch count is 0.
- [x] Rebuild remediation/content-quality/capture-safety controls from live
      truth: 148 unsafe, 14 unsafe duplicate rows, 2 safe duplicate rows, 56
      manual semantic rows, mutation-ready 0.
- [x] Pass focused 16/16, full 224/224, typecheck/build/module/runtime/ranking/
      control/vector/golden/release gates. Closing package scan is 464 files.
- [x] Phase 8D: bind the 3 preserved companions to their rewritten
      representatives, take a fresh encrypted snapshot, soft-archive exactly
      those 3 rows, independently postcheck the transaction, and rebuild the
      662-row candidate/quality controls. Full 229/229 and release pack 478
      pass; ContextEngine, prompt mutation, and final recall remain off.
- [x] Phase 8E: under two fresh encrypted snapshots, first converge the exact
      r8 one-row V1 append and then soft-archive the separate 14-row reversible
      duplicate lane. Candidate 663 -> 649, archived 323 -> 337, active 0;
      V1/V2/four projections remain 986/986 and independent mismatches are 0.
      Rebuilt controls are 0 eligible / 493 hold / 156 quarantine and 131
      unsafe / 2 safe duplicate / 56 semantic review. Full 233/233 and release
      pack 492 pass; ContextEngine, prompt mutation, and final recall remain off.
- [x] Phase 8F-A: converge the exact 15-row nightly V1 append under a fresh
      encrypted snapshot, rebuild the 664-candidate controls, and adjudicate
      all 131 unsafe rows query-only as 99 soft-archive proposals plus 32
      bounded-rewrite holds. No disposition or runtime mutation was performed;
      full 236/236 and release pack 504 pass.
- [x] Phase 8F-B: under independent exact controls, verify/apply any selected
      99-row soft archive and develop bounded rewrites for the 32 held rows.
- [x] Phase 8G: adjudicate the 2 safe duplicates and 56 semantic-review rows.
- [x] Phase 9: make an explicit lifecycle/final-recall cutover or no-cutover
      decision. ContextEngine, prompt mutation, and final recall remain off.

## Phase 8D — Exact companion soft archive

- [x] Require the exact three Phase 8B/8C companion hashes, their current
      unsafe trace bindings, and the paired representative rewrite receipts.
- [x] Fail closed on control/source drift and require a fresh restore-verified
      encrypted snapshot before lifecycle mutation.
- [x] Create exactly 3 archived revisions, sources, supersedes relations, and
      archived events while preserving content, verification, address, ACL,
      V1, projections, outbox, and all runtime gates.
- [x] Run an independent read-only postcheck: 3 archived companions, 3
      preserved representatives, 3 valid receipts, 0 mismatches, integrity ok,
      FK 0.
- [x] Rebase the candidate policy to 662 rows: 0 eligible / 506 hold / 156
      quarantine; rebuild quality to 145 unsafe / 2 safe duplicate / 56
      semantic-review rows, mutation-ready 0.
- [x] Pass focused 5/5, full 229/229, typecheck/build/vector/golden/release;
      closing package scan 478 files.
- [x] Phase 8E remained separate and subsequently soft-archived exactly those
      14 earlier proposals under its own plan, acceptance, fresh snapshot,
      transaction allowlist, and independent postcheck.

## Phase 8E — Exact duplicate-lane soft archive

- [x] Fail closed before write on validator/action mismatch and later V1/V2
      986/985 drift; perform no lifecycle transaction under stale controls.
- [x] Converge the exact r8 operational checkpoint under a fresh encrypted
      snapshot, then conservatively rebase the 663-candidate baseline without
      reusing the stale pre-Phase8D lifecycle baseline.
- [x] Reproduce the exact 5-group / 14-row plan, verify 0 live mismatches and
      0 raw trace/id leak, and take a second fresh encrypted snapshot.
- [x] Create exactly 14 archived revisions/sources/supersedes relations/events
      while preserving content, verification, address, ACL, V1, all
      projections, outbox, non-target rows, and runtime gates.
- [x] Independently postcheck 14 archived rows, 14 valid receipts, 14 relation/
      event/projection bindings, 0 mismatches, integrity ok, and FK 0.
- [x] Rebuild current plans from 649 candidates: 0 eligible / 493 hold / 156
      quarantine; 131 unsafe / 2 safe duplicate / 56 semantic review; exact
      duplicate operational trace lane 0; mutation-ready 0.
- [x] Pass focused 4/4, full 233/233, typecheck/build and all release gates;
      closing package scan 492 files.

## Phase 8F-A — Query-only unsafe-trace adjudication

- [x] Fail closed on the stale Phase 8E baseline after nightly extraction
      appended 15 V1 rows; do not open a write transaction under 1001/986 drift.
- [x] Generalize the V1 append acceptance/rebase control from a single
      operational checkpoint to an exact mixed batch without weakening
      per-row hashes, lifecycle debt, snapshot, or projection checks.
- [x] Under a fresh restore-verified encrypted snapshot, apply exactly 14
      reflection summaries plus 1 operational checkpoint as candidate/
      unverified/legacy-identity debt. V1/V2/four projections become 1001,
      candidate 664, active 0, archived 337, pending 0.
- [x] Rebuild current plans: 0 eligible / 508 hold / 156 quarantine; 83
      assignment / 425 evidence / 156 quarantine; 131 unsafe / 2 safe
      duplicate / 56 semantic review; mutation-ready 0.
- [x] Add a redacted query-only adjudicator over the exact 131-row unsafe lane.
      Result: 99 reversible soft-archive proposals and 32 bounded-rewrite holds
      (7 oversized segmentation + 25 semantic-result rewrite review).
- [x] Verify live corpus 1001/1001 with missing/duplicate mappings 0. Preserve
      the 3 intentional Phase 8C substantive V2 rewrites as an explicit parity
      blocker; active/injectable V2 recall remains 0.
- [x] Pass focused 10/10, full 236/236, typecheck/build/module/vector/golden/
      release gates; closing package scan 504 files.
- [x] Phase 8F-B created separate exact archive and rewrite controls. The
      read-only adjudication authorizes no archive, rewrite, verification,
      lifecycle, ContextEngine, prompt mutation, hard delete, or final recall.

## Phase 8F-B1 — Exact disposition planning

- [x] Fail closed when a new V1 operational checkpoint changes live truth from
      1001/1001 to 1002/1001; create no disposition receipt or write.
- [x] Under a fresh restore-verified encrypted snapshot, migrate exactly the
      one-row r10 append as candidate/unverified/legacy-identity debt. Restore
      V1/V2/four projections to 1002, candidate 665, active 0, archived 337,
      pending 0, with existing canonical/lifecycle/verification/evidence
      changes 0.
- [x] Rebuild all controls from live truth: 0 eligible / 509 hold / 156
      quarantine; 84 assignment / 425 evidence / 156 quarantine; 131 unsafe /
      2 safe duplicate / 56 semantic review.
- [x] Add a query-only disposition planner with 99 unique reversible archive
      targets and 32 bounded rewrite designs (7 oversized segmentation + 25
      durable-result extraction), overlap 0 and mutation-ready 0.
- [x] Independently recompute plan digest
      `527e209f...d09adc`, prove union 131 and no raw/content key leakage, and
      require a fresh encrypted snapshot plus a separate exact apply.
- [x] Pass focused 4/4, full 238/238, typecheck/build/module/vector/golden/
      release gates; closing package scan 511 files.
- [x] Phase 8F-B2 applied only the 99-row archive lane under two fresh,
      restore-verified encrypted snapshots and independent acceptance. A new
      V1 append first triggered fail-closed r11 convergence to 1003/1003.
- [x] Exact archive postcheck proved 99 archived targets, 32 unchanged rewrite
      targets, 99 receipts/relations/events/projection bindings, 0 mismatches,
      integrity ok, FK 0, and no non-target/runtime change.
- [x] Rebase the new 567-candidate lifecycle baseline: 0 eligible / 411 hold /
      156 quarantine; 32 unsafe / 2 safe duplicate / 56 semantic review; 0
      remaining archive proposals / 32 rewrite holds.
- [x] Pass focused 6/6, full 242/242, typecheck/build/vector/golden/release
      gates; closing package scan 521 files.
- [x] Phase 8F-B3 created payload-bearing proposals and a separate exact
      rewrite transaction for only the remaining 32 holds. Phase 8F-B2 grants
      no rewrite, verification, promotion, ContextEngine, prompt mutation, hard
      delete, or final recall authority.

## Phase 8F-B3A — Unsafe trace rewrite proposal controls

- [x] Add an exact 32-row payload planner for 7 oversized segmentation holds
      and 25 semantic durable-result extraction holds. Oversized rows accept
      one to four bounded outputs; semantic rows accept exactly one.
- [x] Keep proposed prose only in a 0600 payload and emit a redacted plan with
      hashes, lengths, evidence digests, counts, and review metadata only.
- [x] Bind the payload and plan to the Phase 8F-B1 disposition digest/SHA plus
      the Phase 8F-B2 apply and postcheck SHA chain.
- [x] Require capture-safety PASS, zero corpus collision, mutually distinct
      outputs, unchanged protected revisions/lineage/category, and a fully
      converged append-only live source extension.
- [x] Add independent acceptance that recomputes the complete proposal and
      rejects proposed-content or raw trace leakage. Proposal and acceptance
      remain non-authorizing and require a fresh snapshot plus separate apply.
- [x] Pass focused 18/18, new B3A 5/5, full 247/247, typecheck/build, module
      boundaries, vector repair, golden recall, and release gate; pack 529.
- [x] Phase 8F-B3B: converge the new exact two-row V1-only append from live
      1005/1003 under a fresh encrypted snapshot, rebuild all controls, then
      create the private payload and design/apply a separate exact rewrite
      transaction. No live private memory content was read or changed in B3A.

## Phase 8F-B3B — Exact unsafe-trace rewrite live apply

- [x] Take a fresh restore-verified encrypted snapshot and converge only the
      exact r12 two-row append. Restore V1/V2 and all four projections to 1005,
      candidate 569, active 0, archived 436, pending 0.
- [x] Rebuild every candidate/content/unsafe control from post-r12 live truth,
      then create and independently accept an owner-only 32-row payload.
- [x] Materialize exactly one bounded safe synthesis per target. Create 32 new
      revisions/sources/supersedes relations/events and update 32 current-FTS
      rows while changing lifecycle, verification, address, ACL, V1, other
      projections, outbox, non-target rows, and runtime gates by zero.
- [x] Independently postcheck 32 rewrite receipts and all protected bindings
      with zero mismatches, integrity ok, and FK 0.

## Phase 8G — Post-rewrite safe-lane adjudication

- [x] Add a receipt-aware boundary that closes the 32 rewritten rows from the
      generic manual-semantic queue only after validating the complete proposal/
      apply/postcheck chain and current safe content digests.
- [x] Review the exact remaining 2 safe duplicates plus 56 semantic rows under
      private operator authority without emitting memory text or raw ids.
- [x] Produce 24 reversible soft-archive proposals and retain 34 durable rows
      for verification; bounded rewrite holds and mutation-ready rows are 0.
- [x] Keep the Phase 8G result query-only. Any future selection of the 24
      proposals requires a separate snapshot-bound exact apply and postcheck.

## Phase 9 — Explicit no-cutover decision

- [x] Bind the current candidate baseline, Phase 8G plan, rewrite postcheck,
      live configuration, database counts, integrity, and V1/V2 divergence.
- [x] Record `no_cutover`: active/injectable rows 0, eligible promotions 0,
      verification debt present, 24 unapplied archive proposals, 47 current
      content differences, and no implemented runtime cutover mode.
- [x] Preserve V1 fallback and read-only shadow; keep lifecycle promotion,
      ContextEngine, prompt mutation, and final recall disabled.
- [x] Pass focused 6/6, full 255/255, typecheck/build/module/runtime/vector/
      golden/release gates; closing package scan 547 files.

Run report:
`docs/clawlore/eval/phase8f-b3b-phase8g-phase9-completion-run-2026-07-14.md`.

## Phase 0 verification

- Focused Memory Address V2 tests: 8/8 PASS.
- Full plugin tests: 96/96 PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run smoke:clawlore-address-v2`: PASS.
- `npm run release:gate`: PASS; pack scan 222 files.
- Live extension/config/database/Gateway: unchanged.

## Phase 1A verification

- Focused ContextPack/adapter tests: 6/6 PASS.
- Full plugin tests: 102/102 PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- ContextPack V1 smoke: PASS; one bounded retrieval; no hook mutation.
- Address V2 and vector-repair smokes: PASS.
- Golden recall: recall 1.0; forbidden violations 0.
- `npm run release:gate`: PASS; pack scan 234 files.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 1B verification

- Focused legacy-source/comparison tests: 6/6 PASS.
- Full plugin tests: 108/108 PASS.
- `npm run typecheck` and `npm run build`: PASS.
- Legacy shadow smoke: PASS; 3 hook outputs -> 1 ContextPack; deterministic.
- Safe fixture candidate preservation: 5/5; unexplained rejection 0.
- Address V2, ContextPack V1, and vector-repair smokes: PASS.
- Golden recall: recall 1.0; forbidden violations 0.
- `npm run release:gate`: PASS; pack scan 243 files.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2A verification

- Agent facade/ContextEngine focused tests: 2/2 PASS.
- Full plugin tests: 119/119 PASS.
- `npm run typecheck` and `npm run build`: PASS.
- Release gate: PASS; pack scan 265 files.
- Golden recall: recall 1.0; forbidden violations 0; prompt budget exceeded 0.
- The first release-gate run correctly exposed stale discoverability assumptions;
  the gate contract was updated and the complete gate then passed.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2B verification

- Module-boundary tests: 2/2 PASS.
- Snapshot/restore tests: 2/2 PASS.
- Full plugin tests: 123/123 PASS.
- `npm run typecheck`, build, vector-repair smoke, golden recall, and release
  gate: PASS.
- Release gate pack scan: 275 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2C verification

- Migration apply/rollback tests: 2/2 PASS.
- Full plugin tests: 125/125 PASS.
- Typecheck/build/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 279 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2D verification

- Encrypted archive tests: 3/3 PASS.
- Full plugin tests: 128/128 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 283 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- First focused run exposed plaintext SQLite WAL/SHM cleanup debt; cleanup was
  repaired and the focused/full gates then passed.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 2E verification

- Projection convergence tests: 2/2 PASS.
- Full plugin tests: 130/130 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 287 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 3A verification

- Unified legacy-trigger tests: 2/2 PASS.
- Full plugin tests: 132/132 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 291 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 4A verification

- Memory Center tests: 2/2 PASS.
- Full plugin tests: 134/134 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 299 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- The first historical-conflict regression run exposed a stale test expectation
  after adding a second correction fixture; the expectation was corrected and
  the complete gates then passed.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 5A verification

- Subagent/Experience lifecycle tests: 2/2 PASS.
- Full plugin tests: 136/136 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 311 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- The first typecheck exposed direct experimental `node:sqlite` type coupling;
  the storage adapter was aligned with the existing runtime-load boundary.
- Review then found active snapshots after child completion and missing evidence
  ownership checks; finalization is now atomic and ownership is enforced.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 6A verification

- Release-readiness/support-bundle tests: 3/3 PASS.
- Full plugin tests: 139/139 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 319 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- The first compatibility test assumed a nonexistent `cli.commands` manifest
  node; it was corrected to the actual top-level `commandAliases` contract.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 6B verification

- Runtime composition tests: 5/5 PASS.
- Fixture-host JSON smoke: PASS; disabled hooks 0, shadow hooks 1.
- Shadow receipt: completed; retrieval invoked; one safe candidate selected.
- Tool registrations 0; writes disabled; prompt mutation disabled; ContextEngine registration disabled.
- Full plugin tests: 144/144 PASS.
- Typecheck/build/module-boundary/vector-repair/golden recall/release gate: PASS.
- Release gate pack scan: 324 files.
- Golden recall: 1.0; forbidden violations 0; prompt-budget exceeded 0.
- Live extension/config/database/hooks/ContextEngine/Gateway: unchanged.

## Phase 6C verification

- Live Gateway: `active/running`; port 19021 `/healthz` returned live.
- Runtime receipt: `registered`, mode `shadow`, hooks 1, writes false, prompt
  mutation false, ContextEngine false.
- Registered observer: `message_received`; live source/dist hashes match the
  isolated candidate.
- Real Telegram direct trace: identity pass, policy pass, retrieval invoked,
  candidates 0, selected 0; trace file remains 0600 and contains no raw message
  or principal identifier.
- Live V2 table count: 0 across the complete Truth/Experience V2 table set.
- Full plugin tests: 149/149 PASS; typecheck/build/runtime composition/module
  boundary/vector repair/golden recall/release gate PASS; pack scan 330 files.

Run report:
`projects/clawlore/docs/clawlore/eval/phase6c-live-shadow-run-2026-07-12.md`.

## Phase 6D observation-audit verification

- Focused audit tests: 3/3 PASS (safe aggregate, unexpected payload rejection,
  group-readable permission rejection).
- First live audit: PASS; mode 0600, samples 6, accepted samples 1, retrieval
  invoked 1, issues 0, positive-candidate samples 0.
- Full plugin tests: 152/152 PASS; typecheck/build/release gate PASS; pack scan
  333 files.
- Post-restart direct observation: 3/3 accepted direct/private samples; identity
  and policy pass 3/3, retrieval invoked 3/3, positive-candidate samples 3/3,
  maximum candidate count 5, and trace issues 0.
- Authorized Telegram group observation: `group` / `conversation`, identity
  pass, `same_conversation` policy pass, retrieval invoked, 6 candidates, 0
  selected, and explicit `private_principal_mismatch` rejection.
- Final observation receipt: mode 0600, decision `go`, no blockers; 6 accepted
  direct/private samples, 1 accepted group/conversation sample, 6 positive
  candidate samples, maximum candidate count 6, issues 0. It explicitly keeps
  writes, prompt mutation, and ContextEngine false and
  `authorizesV2Writes=false`.
- Receipt regression bundle: focused 5/5, full 154/154, typecheck/build/release
  gate PASS; pack scan 334 files.

Run report:
`projects/clawlore/docs/clawlore/eval/phase6d-shadow-observation-audit-run-2026-07-12.md`.

## Boundaries

- Phase 6C authorizes only the currently deployed read-only shadow observer.
- Do not mutate the live memory database or enable V2 writes outside a verified
  readiness receipt, exact plan digest, fresh snapshot, and bounded executor.
- Do not select the ContextEngine slot or enable prompt mutation.
- Do not rename package, CLI, config root, tools, or data paths.
- Do not replace the three legacy prompt hooks until shadow comparison passes.
