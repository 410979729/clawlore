# ClawLore 1.2.1 nineteenth self-audit and remediation run

Audit window: 2026-07-20 through 2026-07-21 CST
Audit owner: Tianji
Candidate: `/home/a/openclaw-tianji/home/state/workspace/projects/clawlore`
Scope: source, tracked dist, tests, package/release contracts, Linux Node 24.15,
authorized isolated Windows Node 24.15, and cleanup
Excluded: live deployment, live config/database/vector mutation, Gateway
restart, recall/V2 cutover, live secret review, and the deferred SATA/SSD item

## 1. Conclusion

The current **source bytes and local candidate commit are pre-push-gate ready**,
but the current remote identity is **not yet publishable**.

Both Linux and Windows passed the complete `release:prepush` gate from a clean,
isolated Git checkout whose synthetic `origin` matched the declared canonical
repository. This proves that the candidate source, generated dist, package,
tests, packed-tarball smokes, supply-chain gates, and release contracts can pass
without weakening the repository-identity policy.

The real checkout still intentionally fails before running the gate because:

- package metadata names `github.com/410979729/clawlore`;
- the actual `origin` still names
  `github.com/410979729/scope-recall-openclaw`;
- the declared canonical repository is not reachable yet.

The complete candidate was committed locally as
`977e20375fec7cbc6be76b566c12d1ca0ffb5d77` on
`feature/clawlore-identity`. It contains source, tracked dist, tests, release
contracts, and formal project documentation as one exact candidate. No remote
or external ref was changed.

Audit-ledger-only commit `76d651f3afb5a0c2b2da224d3cfb6aa6d02624bd`
then recorded that candidate. The release-input contract explicitly excludes
`TODO-clawlore.md`, `docs/clawlore/project-handoff.md`, and
`docs/clawlore/eval/`; later ledger corrections therefore do not change the
tested source/package identity.

Therefore the honest boundary is:

- **code/test/package candidate: GO for push after canonical remote setup**;
- **actual push/tag/release: NO-GO until repository identity is resolved**;
- **live deployment/cutover: outside this source-only authorization and still
  NO-GO**.

No claim is made that another independent reviewer cannot discover a new
issue. This run instead closes the concrete mechanisms found by a fresh
adversarial pass and makes the remaining blockers externally observable rather
than hidden behind passing example tests.

## 2. Fresh self-audit findings and fixes

### 2.1 Secret policy was not yet the final persistence and egress boundary

Earlier rounds unified capture, support-bundle, and Task Experience handling,
but a fresh call-site audit found additional provider, embedding, CLI,
reflection, digest, governance, legacy, shadow, compaction, V2 Truth, and V2
Experience paths that could persist or emit data without consuming the same
final policy.

The candidate now has explicit, single-purpose policy owners for:

- structured and unstructured secret detection/redaction;
- provider-output and embedding-error handling;
- memory-entry admission and merge handling;
- metadata recursion and absolute-path rejection;
- memory egress/export policy; and
- V2 Truth and Experience write policy.

The policies cover nested JSON strings, YAML/JSON structured values, common
authorization schemes, aliases, provider errors, exported/imported records,
reflection and digest content, legacy rebuild paths, and V2 persistence. Tests
assert both rejection and that final emitted/stored output does not contain the
complete value.

### 2.2 Task outcome could still be contradicted by later unrelated success

Task Experience now treats unresolved structured failures as terminal evidence.
A later unrelated successful tool result or positive sentence cannot erase the
failure. Historical failures are accepted only when the transcript explicitly
proves that the failure was repaired and the final verification succeeded.

The full capture gate, reviewer normalization, promotion eligibility, and
durable episode write share that outcome contract. Free-form stdout is not a
structured success signal.

### 2.3 Runtime session correlation and bounded state needed stronger ownership

Auto-recall and capture state now use bounded TTL containers and exact
session/run/message ownership. Ambiguous id-less concurrency fails closed;
session cleanup cannot traverse a principal hint into another session; stale
entries are evicted with bounded metrics; and duplicate/reordered completion
events cannot replay a prior prompt or capture.

### 2.4 Durable file and SQLite sidecar privacy had uneven enforcement

Private writes now use owner-only creation, atomic replacement, symlink
refusal, and dedicated private lock handling. SQLite database, WAL, and SHM
permissions are normalized at the authority boundary. Migration markers,
shadow traces, reflection state, self-improvement state, and learning files use
the same private-file assumptions instead of duplicating weaker helpers.

Self-improvement files additionally reject traversal and symlink targets,
escape/redact content, and preserve atomic rollback semantics.

### 2.5 V2 semantic writes required a stricter domain boundary

Identifier validity is no longer treated as proof that content is safe or
semantically complete. V2 Truth and Experience writes require explicit scope,
state, evidence, immutable identity, and the shared persistence policy.
Distillation, subagent experience, legacy migration, V1 append delta, and V2
rollout paths consume those contracts rather than writing around them.

This is source hardening only. It does not authorize live V2 writes or data
governance.

### 2.6 Architecture and release provenance needed a final non-growth pass

New independent responsibilities were extracted into focused modules rather
than extending the existing `store`, service, and helper hotspots. The
architecture/source-governance ledgers were updated; reverse-dependency debt is
29; and `src/store.ts` is 2,008 lines, below its 2,010-line exact non-growth
ceiling. Source and generated dist remain one-to-one under the release mapping
gate.

The package moved to `1.2.1`. A non-authorizing pre-push mode verifies clean
candidate bytes before publication, while the strict post-push gate still
requires an exact reachable remote ref and canonical evidence. Pre-push mode
cannot claim that publication already happened.

### 2.7 Node 24 compatibility floor was stale

The last fresh compatibility check found the release candidate and CI still
allowed Node `24.14.0`, while the installed OpenClaw `2026.7.1-2` package
requires Node `>=24.15.0 <25` on the Node 24 line.

The package engine, lockfile root engine, Linux/Windows workflow, reusable CI
template, release contract, tests, and changelog now require Node
`>=24.15.0 <25`. The supported `/usr/bin/node` 24.15.0 loads the installed
OpenClaw CLI successfully. The older shell-default 24.14.0 binary was not
modified and is no longer accepted as release evidence.

## 3. Linux verification

Final supported host: Linux x64, Node 24.15.0.

| Check | Result |
|---|---|
| full test suite | 570 total / 568 pass / 0 fail / 2 skip |
| typecheck | pass |
| build | pass |
| focused release/architecture tests | 32/32 pass |
| source/dist release mapping | 244/244, missing 0, extra 0 |
| `git diff --check` | pass |
| production dependency audit | 0 vulnerabilities |
| `npm pack --dry-run` | 260 files; 530,048 packed bytes |
| 200K known-answer recall | 1 |
| 200K cross-scope leakage | 0 |
| 200K FTS latency | p50 0.034 ms; p95 0.045 ms; max 0.141 ms |
| 200K lifecycle | stats 452.696 ms; health 352.786 ms; counts 99.907 ms |

The real checkout's `release:prepush` stops at the expected package/origin
mismatch. To distinguish provenance failure from a product failure, the exact
candidate was copied to an isolated clean Git repository with a matching
non-network synthetic canonical origin. The complete Linux pre-push gate then
passed, including:

- clean-tree and release-input verification;
- full tests, typecheck, build, both benchmarks, and pack scan;
- install from the generated tarball;
- packed runtime, native LanceDB, real OpenClaw CLI, and legacy migration
  smokes;
- SBOM generation with 43 components; and
- official-registry production audit with 0 vulnerabilities.

Stable evidence identities from that clean candidate:

- release input:
  `1974bef5aa74dc31611bada2589511e14e9b86c8c13d685a0c02e03cd9f59088`
- runtime:
  `2b0446f09dba4465595a51078decf81326645806cc503e21b7458d8c41692756`
- package lock:
  `f92541f2bc73ae374a071a1f48fcc9f3ac33ede38c4aeb839a21a5384a2251d4`

An earlier pre-commit isolated controller attempt was discarded because its
controller removed the checkout before the child process completed, producing
`uv_cwd`. It is not counted as candidate evidence. After staged whitespace
checks changed one test-file byte, both platforms were rerun on final release
input `1974bef5...`; the final Linux run exited 0 and removed its exact
temporary root.

## 4. Authorized Windows verification

Final host: Joy's authorized work computer, Windows x64, official portable
Node 24.15.0. The global Node installation and work environment were not
changed.

The test root was created under the current user's local profile with
inheritance removed. Its only Allow ACEs were the current Administrator,
SYSTEM, and BUILTIN Administrators, all non-inherited FullControl. TEMP, TMP,
npm cache, dependencies, source, logs, and portable Node stayed inside that
owned root.

The official Node archive SHA-256 was
`cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62`
and matched the official `SHASUMS256.txt`. The transferred candidate archive
SHA-256 was
`890a31d2b9e6345e15597f5115554c664d3697d28cdfb30d1d731d167b8e93c5`.

The complete Windows pre-push gate exited 0:

| Check | Result |
|---|---|
| full test suite | 569 total / 552 pass / 0 fail / 17 skip |
| typecheck / build | pass / pass |
| clean Git tree | pass |
| packed runtime/LanceDB/OpenClaw/legacy smokes | pass |
| production dependency audit | 0 vulnerabilities |
| package scan | 260 files |
| SBOM | 45 components |
| 200K known-answer recall | 1 |
| 200K cross-scope leakage | 0 |
| 200K FTS latency | p50 0.018 ms; p95 0.021 ms; max 0.130 ms |
| 200K lifecycle | stats 250.991 ms; health 192.062 ms; counts 58.925 ms |

The lower Windows test total and 17 skips are platform-conditioned selections;
the gate records zero failures. Release-input, runtime, and package-lock
digests exactly matched the clean Linux candidate. SBOM component count differs
only by platform dependency resolution, which the evidence contract permits.

## 5. Remaining boundaries

Only these actions remain before an actual repository update can be claimed:

1. Joy chooses either to create the private canonical `clawlore` repository or
   rename the existing `scope-recall-openclaw` repository.
2. Update `origin` to that reachable canonical repository without weakening
   the identity gate.
3. Run the real pre-push gate from the clean branch containing candidate
   `977e203`, push its exact branch, then run the strict post-push evidence
   gate against the reachable ref.
4. Obtain a fresh independent read-only review of that exact commit before tag
   or release publication.

Operational observations from the eighteenth review remain separate:

- live recall scope alignment has no positive-candidate/cutover proof;
- live Task Experience has no reusable-capsule effectiveness proof;
- V2/truth gaps and duplicate groups need read-only classification and an
  approved dry-run receipt before any data write; and
- the one low-confidence live secret-pattern candidate still requires a
  separately authorized, no-plaintext review.

Those observations do not block forming and pushing a source repository
candidate, but they do block claiming live rollout or cutover readiness.

## 6. Cleanup and non-actions

The exact Windows audit root was checked for residual Node processes, then
removed recursively. A final probe returned `ROOT_EXISTS_AFTER=False`. The
local transfer root containing the checksum list, portable Node archive,
candidate archive, and copied log was also removed and verified absent. These
were disposable task-owned test artifacts and are not recoverable.

Formal source, tests, tracked dist, lockfile, release contracts, changelog,
TODO/handoff updates, and this report are retained as deliverables.

The final workspace state-hygiene audit returned `STATE_HYGIENE_ISSUES 105`:
51 backup-like paths outside the workspace, 4 foreign canonical documents, 5
root config backups, and 45 session backup/reset/deleted paths. The categories
overlap. They are existing state/session/third-party artifacts outside the
project workspace and were not deleted under this source-audit authority. The
increase from the eighteenth round's 103 is one later session-layer
`.jsonl.deleted` file counted in both the backup-like and session categories;
it is not a ClawLore test artifact.

This run did not deploy the candidate, modify live plugin/config/database/vector
state, restart the Gateway, change the work computer, push, tag, release, or
act on the deferred SATA/SSD issue.
