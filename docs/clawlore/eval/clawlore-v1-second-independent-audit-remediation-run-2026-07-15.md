# ClawLore v1 second independent audit remediation — 2026-07-15

## Decision

The source candidate closes the three release blockers and four should-fix
items reported by Tianxuan against commit
`af8bab1844d9ba57145b73430f413f5a271054c7`. The candidate remains a source
release candidate only: it is not deployed, pushed, tagged, or authorized for
V2 cutover. Independent re-audit of the clean commit containing this report is
the next gate.

## Closed release blockers

### SQL truth remains authoritative when vector mutations fail

- Every vector candidate is rehydrated from SQLite by id before ranking or
  return. Missing SQL ids are discarded; stale vector text and metadata never
  become recall truth.
- Delete, update, and supersede companion failures create durable
  `vector_companion_repair_outbox` debt. A replace operation clears debt only
  after both vector delete and add succeed.
- Fault-injection coverage spans delete, update, and supersede; vector-delete,
  vector-add, and mixed partial failures; LanceDB and sqlite-bruteforce
  companions. Deleted facts do not return, updated facts use current SQL text,
  and superseded facts cannot return as active truth.

### Experience Kernel uses the same principal boundary as core memory

- Experience search, inspect, preflight, episode completion, feedback, stats,
  replay, and review receive `resolveRuntimeMemoryAccess()` output rather than
  reconstructing legacy `agent:<id>` scope.
- Direct principals receive disjoint scope filters, groups and unresolved
  principals fail closed, and by-id reads or mutations re-check accessible
  scope.
- `scope_ids=[]` means deny all. Only an explicit system/operator bypass may
  omit the filter with `undefined`.

### Auto-recall cache is session-bound and bounded

- Cache identity prefers stable `sessionKey` / `sessionId`; the fallback tuple
  includes channel, account, conversation, sender, and agent. A provider-only
  value such as `telegram` is rejected.
- Interleaved direct and group sessions keep independent raw-message state;
  session cleanup removes only its own entry.
- The cache is bounded to prevent abandoned session keys from growing without
  limit.

## Closed should-fix items

- Regex fallback after extractor failure is stored as degraded pending
  evidence and is not auto-injectable until explicit promotion and trust
  repair.
- Diagnostic logs use lengths, counts, and process-local keyed hashes; raw
  message previews, account/conversation/session identifiers, response JSON,
  and HTTP error bodies are not logged.
- The release gate scans the extracted `npm pack` payload for private keys,
  high-confidence token patterns, credential assignments, private local paths,
  and known diagnostic preview templates. Runtime package contents are reduced
  with an explicit `files` allowlist.
- The benchmark suite now contains 124 curated and explicitly annotated
  synthetic cases across fact conflicts, preference and project scope,
  experience/forgetting, multilingual scope, and attack boundaries. It reports
  Recall@K, top-K accuracy, MRR, nDCG, bad-recall, forbidden violations,
  cross-scope leakage, latency, and prompt budget. This is deterministic
  engineering evidence, not a substitute for an independent human relevance
  panel.
- A 200,000-row SQLite FTS baseline measures build/query latency, known-answer
  recall, and scope leakage. It is not represented as a hosted embedding,
  reranker, or million-row production load test.
- Runtime model credentials use OpenClaw SecretRef objects. Gateway reload was
  verified on the live legacy deployment. Candidate CLI metadata registration
  now defers database and secret materialization until command execution, then
  resolves refs through the public host secret-resolution API. An isolated
  File SecretRef `clawlore stats --json` smoke passed without printing or
  persisting the resolved value. The minimum host/plugin SDK is therefore
  pinned to OpenClaw `2026.7.1-beta.5`.

## Verification contract

The clean commit containing this report must pass all of the following before
it is handed to Tianxuan:

- 301/301 tests;
- TypeScript typecheck and production build;
- vector repair smoke;
- curated 124-case recall benchmark with zero forbidden, bad-recall, and
  cross-scope-leakage results;
- 200,000-row synthetic SQLite FTS scale baseline;
- zero production dependency vulnerabilities;
- source release gate with `dirty=false`, package-lock SBOM, extracted package
  content scan, and bounded pack file count;
- clean-copy reproducible install/build/test/gate;
- isolated OpenClaw inspect plus canonical and compatibility CLI command smoke,
  including File SecretRef materialization.

The exact commit and runtime digest are taken from the final clean release-gate
output. Auditors should obtain them from the checkout (`git rev-parse HEAD`) and
recompute them rather than trusting a self-referential hash embedded in the
same commit.

## Live boundary

The live extension remains `scope-recall-openclaw@1.1.0`; no source candidate
was copied into the extension directory. Telegram sender allowlisting, explicit
group/wildcard memory-tool deny, service `UMask=0077`, and SQLite/WAL/SHM `0600`
remain the live containment controls. V2 still has no authorized cutover:
zero-active lifecycle and insufficient real shadow parity remain fail-closed
conditions.

## Release limitations

- This remediation does not create independent human relevance labels or a
  production vector/reranker load study.
- It does not promote V2 data, change the live memory slot, rename the live
  extension, push a repository, or claim commercial maturity.
- Any source, config, data, or runtime digest change invalidates this evidence
  and requires re-running the gates.
