# ClawLore 1.2.2 audit remediation — 2026-07-23

## Decision and evidence ranking

This source-only remediation has two stages:

1. `5fb5d7bc9bb848ba2ce7898c1c1dd53f101480de`, based on the verified P8
   candidate `1df27e1f9af7bcf9398e14f84d682872f70cd099`, fixed the projection
   fencing, Playbook supersede, diagnostic-code disclosure, bounded LanceDB
   access, and cross-process write-lock findings from three earlier audits.
2. The commit containing this record responds to the independent
   post-remediation audit of `5fb5d7b`.

For the second stage, the Yuheng post-remediation audit is the stronger source
audit. It names the exact candidate, separates source, package, publication,
and live evidence, and includes executable SQLite/LanceDB/manifest
counterexamples. The Tianxuan revalidation remains useful as a live
containment checklist, but its statement that no candidate change existed
after P8 was stale because it did not include `5fb5d7b`.

The reports therefore have different roles:

- Yuheng is the remediation authority for source findings.
- Tianxuan is retained for live containment and production-governance checks.
- Neither report authorizes deployment, data mutation, credential work, cron
  changes, or a Gateway restart.

This worktree does not modify the live extension, OpenClaw configuration, cron
jobs, credentials, memory databases, Gateway process, daily dirty workspace,
or canonical remote.

## Source remediations

### Persisted-secret inventory

- The audit and remediation plan now require one or more explicit
  backup/export/restore artifact roots in addition to the SQLite and LanceDB
  surfaces.
- Artifact inventory is bounded by file count, per-file bytes, total bytes,
  and line length. It refuses symlink roots, directory escapes, symlinked
  entries, unsupported file types, concurrent inventory drift, and unknown
  opaque containers.
- Scannable JSON, JSONL, NDJSON, CSV, Markdown, and text artifacts are streamed.
  Recognized encrypted containers are content-hashed without exposing paths or
  content. Renaming plaintext to an encrypted-looking extension does not pass;
  neither does arbitrary binary data with a high-bit first byte.
- Receipts expose only root/file references, counts, pattern classes,
  permission state, coverage, and content-bound digests. Receipts must be
  outside every audited or remediated surface.
- Missing roots, incomplete coverage, artifact secret findings, unsafe
  permissions, or unavailable permission verification block a green plan.
  Artifact cleanup remains a separate, explicitly reviewed action; the
  database remediation command cannot silently delete historical files.

This closes the source-level false-green path identified by Yuheng. It does
not claim that the live artifact inventory is complete or clean: the exact
live roots still need to be declared and audited after all writers stop.

### LanceDB scan and migration semantics

- A full-table scan now executes one bounded async LanceDB query with an
  overflow row and consumer-side pages. It does not reissue mutation-sensitive
  offset queries.
- A real LanceDB regression deletes the first row after the first consumer page
  and proves the pinned query still observes the original four-row snapshot.
- Persisted-secret audit/remediation scripts stream rows and aggregate bounded
  counts/digests instead of calling unbounded `toArray()`.
- Legacy migration pins a source-table version, streams bounded batches, and
  fails closed for a missing table, unreadable source, unsupported schema, or
  scan-budget exhaustion. Only a successfully opened, valid empty table may
  report “No data to migrate.”

### Mutation serialization and transaction boundaries

- MemoryStore initialization now acquires the canonical cross-process
  memory-write lock before creating or migrating LanceDB schema, indexes, or
  SQL truth.
- FTS rebuild uses the same lock. Deterministic tests hold the lock and prove
  initialization and FTS mutation do not begin early.
- Persisted-secret remediation planning and apply use the same canonical lock
  as normal memory writes. Operational quiescence is still required because
  external writers are not assumed to honor the plugin lock.
- Experience snapshot, scratch, finalization, parent verification, Playbook
  creation, promotion, and quarantine now persist their linked audit event in
  the same SQLite transaction. Event-failure injection proves every state
  mutation rolls back.

### Agent tool availability

- `agentToolProfile` is the single public authority for both manifest
  discovery and runtime registration:
  `read-only`, `memory-write`, `self-improvement`, `operator`, or
  `operator-secret-index`.
- `read-only` preserves `memory_recall` and query-safe Experience tools while
  removing durable writes. Higher profiles add memory writes,
  self-improvement tools, operator tools, and finally secret-index writes.
- The four overlapping legacy booleans are rejected instead of being combined
  into ambiguous gates.
- A matrix test compares the manifest against runtime registration for all
  profiles. A separate smoke loads OpenClaw 2026.7.2's real manifest-signal
  evaluator and proves host availability equals runtime registration,
  including the default profile.

Any deployment from an older configuration must first migrate to an explicit
profile. The live containment target is `agentToolProfile: "read-only"`;
deploying this candidate against a config that still contains a rejected
legacy boolean would fail closed.

### Diagnostic totality

- LLM failure classification now has a visited-object set and depth bound.
  Cyclic `response` graphs, throwing getters, and hostile coercion objects
  return stable content-free diagnostics rather than escaping or overflowing
  the stack.

## Verification

The final source shape was verified with:

- `npm run typecheck`: pass.
- `npm run build`: pass; tracked `dist` was regenerated.
- Focused audit regressions: 60/60 pass.
- Complete `npm test`: 634 tests, 632 pass, 0 fail, 2
  platform-conditioned skips.
- Real OpenClaw 2026.7.2 manifest evaluator: all five profiles and the default
  profile match runtime registration.
- Vector-repair smoke: pass.
- Deterministic commercial recall benchmark: 124/124 expected hits,
  `knownAnswerRecall=1`, `mrr=1`, no forbidden results, and no cross-scope
  leakage.
- Isolated package smoke: 295-file package installed with the real local
  OpenClaw optional peer and passed runtime registration. The direct checkout
  invocation without that optional peer was an environment-resolution failure,
  not counted as a pass.

The verification host runs Node 24.14.0, while the package declares
`>=24.15.0 <25`; the isolated install consequently emitted the expected engine
warning. These tests do not replace the formal release gate on a conforming
Node runtime.

The canonical publication gate is also still blocked: the package declares
`github.com/410979729/clawlore`, the configured origin still names
`scope-recall-openclaw`, and the declared canonical repository was not
reachable during the independent audit. No remote was rewritten and no
publication claim is made.

## Production status

Production remains **NO-GO**. Source regressions are not the same as live
governance completion. Before a deployment can be considered:

1. Disable both bypass writers and keep automatic capture/recall off.
2. Rotate potentially exposed credentials.
3. Create fresh, restore-verified encrypted snapshots of memory,
   conversation, and vector state.
4. Declare and audit every live backup/export/restore root; review every
   finding, remove or encrypt approved historical plaintext, and obtain a
   complete owner-only receipt.
5. Regenerate the exact database remediation plan after writers stop, then
   apply only with explicit approval and postchecks.
6. Resolve attributable principals without converting unresolved rows by
   guesswork, tighten persisted-store permissions, and obtain fresh
   readiness/approval evidence.
7. Establish a reachable canonical remote, verify the exact remote ref, and
   run the formal release gate on Node `>=24.15.0`.
8. Deploy once into shadow/read-only containment, restart once, then perform
   live doctor, Telegram canary, rollback, and only later recall/capture gates.

The live-provider 40-positive/10-negative receipt was previously verified, but
the provider was not rerun in this remediation. SSRF policy for configurable
provider endpoints and CAS semantics for LLM read-modify-write merges remain
separate design work.
