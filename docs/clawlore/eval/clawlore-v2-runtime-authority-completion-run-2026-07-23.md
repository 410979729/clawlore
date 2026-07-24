# ClawLore V2 runtime authority completion run

- Date: 2026-07-23
- Candidate: `fix/clawlore-v2-cutover-20260723`
- Base: `aa95b9be6a954dd62b092c6cdce664df555700ad`
- Candidate version: 1.2.3
- Scope: source, tests, package, and operator contract only
- Live/config/service/GitHub mutation: none

## Closed behavior

1. Native V2 recall cutover
   - registers the canonical OpenClaw ContextEngine id `clawlore`;
   - resolves only exact direct-session principals;
   - injects only active, verified, policy-approved V2 rows;
   - rejects group and unresolved sessions before retrieval;
   - does not ingest transcripts or take ownership of compaction.
2. Runtime V2 write transition
   - adds the store-only `v2-write` Agent tool profile;
   - mirrors one accepted manual V1 write into V2 truth and every local
     projection in one SQLite transaction;
   - compensates the V1 write if mirroring fails;
   - blocks legacy update/forget and automatic V1 writers during transition
     and cutover.
3. Cutover and retirement gates
   - adds a read-only CLI preflight;
   - reports cutover readiness separately from V1 retirement readiness;
   - checks schema, integrity, foreign keys, mapping, principal, lifecycle,
     verification, content, FTS, outbox, and candidate disposition.
4. Release boundary
   - promotes the candidate to 1.2.3;
   - moves the accumulated Unreleased changes into 1.2.3;
   - includes the preflight CLI and generated runtime modules in the package.

## Verification

```text
PATH=/usr/bin:$PATH npm run typecheck
PASS

PATH=/usr/bin:$PATH npm run build
PASS

PATH=/usr/bin:$PATH npm test
649 tests; 647 pass; 0 fail; 2 platform skips

PATH=/usr/bin:$PATH npm pack --dry-run --json
clawlore-1.2.3.tgz; 303 files; required V2 runtime/preflight files present
```

The real-store canary regression writes the SILVER-ORBIT fixture and proves
immediate exact lexical visibility. The runtime mirror regression proves the
same content is immediately visible through the V2 retriever for the exact
private principal, with active/user-confirmed lifecycle and converged
projections.

## Authority end state

V1 and V2 are not permanent peers. V1 is authoritative in shadow and remains a
compatibility/rollback lane during V2-write. V2 becomes the recall authority at
cutover. V1 remains dual-written only for the bounded rollback observation
window, then leaves the normal runtime after `v1RetirementReady: true`; future
access is explicit migration/archive tooling.

## Explicit non-claims

- No production database was migrated or promoted.
- No live ContextEngine slot was changed.
- No Gateway was restarted.
- No Git tag or GitHub Release was created.
- Historical Phase 9 `no_cutover` evidence remains historical truth for the
  earlier dataset; it is not rewritten to manufacture a current GO.

Final release-gate and commit identities are appended after the clean candidate
is committed.
