# ClawLore 1.2.2 twenty-first quality and SQLite-transcript run

Date: 2026-07-22

## Decision

The twentieth-run candidate was correctly blocked by the expanded 40-positive
plus 10-no-answer corpus. This follow-up fixes the retrieval and transcript
source defects without lowering a quality threshold and without modifying
production state. The candidate remains non-authorizing: it does not deploy,
change cron/configuration, rotate credentials, purge live stores, or restart
the Gateway.

## Retrieval correction

Manual recall now retrieves a bounded 20-candidate pool, computes lexical
evidence directly between the query and candidate text, and returns at most the
operator-requested limit. Local candidate-pool IDF prevents common names and
question boilerplate from masquerading as relevance. A narrow answer-shape
tie-break handles entity-enumeration questions; a strongly separated semantic
winner remains the only vector-only fallback.

The review also found a second hidden reinforcement path in the retriever:
manual-source results could call an injected access tracker even after the
tool-level metadata patch had been removed. The tracker setter and calls were
deleted, and both tests and the release gate now reject their return. Ordinary
recall is observation-only; explicit feedback remains a separate journaled
governance action.

The deterministic compatibility embedding increased from 96 to 384 dimensions
to reduce fixture hash collisions. A broad operation-request noise pattern was
split so one-off commands remain noise while durable post-operation rules stay
eligible. Against the unchanged schema-v2 fixture and thresholds, the final
offline result is:

- Recall@3: 1.0
- Precision@3: 1.0
- MRR: 1.0
- no-answer abstention rate: 1.0
- false-positive results: 0
- cross-scope leakage: 0
- unsafe egress: 0

This is reproducible offline evidence, not a live-provider semantic claim.
`liveProviderSemanticReady` remains false until the credential and production
security gates are independently cleared.

## SQLite transcript source

The digest CLI can now read the active OpenClaw SQLite transcript schema by
exact session id. The storage adapter:

- opens the database read-only and sets `PRAGMA query_only=ON`;
- requires the database and existing WAL/SHM companions to be owner-only
  regular files and rejects symlinks;
- requires an exact session id, explicit target principal/private-session
  identity, and a bounded time window/event count;
- admits only user/assistant text and assistant tool names;
- excludes tool arguments, tool-result bodies, thinking, custom events,
  session keys, and raw session identifiers;
- fails when the selected window contains no eligible events.

The default CLI behavior remains dry-run. Transcript chunks are raw evidence,
not promoted truth, and an explicit apply still creates only reviewable digest
candidates. No active cron was modified or implicitly migrated.

## Verification and remaining blockers

Focused typecheck/build and 24 retrieval, digest, architecture, noise, and
SQLite-source tests pass. The SQLite tests prove byte/mtime stability, no new
WAL/SHM files, exact-session isolation, scope binding, fail-closed schema and
permission handling, and zero digest-ledger or memory writes during dry-run.

The full source/pre-push gate and final clean-commit bundle are recorded in the
separate operator receipt generated from this run. Production remains blocked
until the persisted-secret audit is clean, possibly exposed credentials are
rotated, both bypass write crons are disabled, `autoBackup` is false, a live
provider gate passes, and the controlled high-impact authorization boundary is
available.
