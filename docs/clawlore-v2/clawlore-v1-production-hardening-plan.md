# ClawLore v1 production hardening plan

Status: active from 2026-07-14 after the independent post-Phase-9 audit.

## Naming and boundary

ClawLore v1 is the product generation. Existing `V1` / `V2` identifiers remain
internal migration and data-architecture terms. The live package, manifest,
configuration root, CLI aliases, and data path remain on the compatible
`scope-recall-openclaw` 1.x surface until a separately reviewed rename.

Phase 9 closed the original migration roadmap with `no_cutover`; it did not
prove production readiness. This plan closes the independent audit blockers
before any V2 write, native ContextEngine, prompt mutation, or final-recall
cutover can be considered.

## H1 — Mutation authorization and diagnostic privacy

- Route explicit correct/forget through the same address policy used for read
  boundaries, including conversation, thread, and project checks.
- Preserve candidate/observed lifecycle during correction.
- Reject correction of archived/superseded/purged memory until a separate,
  explicit restore operation exists.
- Remove user-derived notes, examples, previews, session names, source ids, and
  actor ids from default doctor JSON.
- Require adversarial regression tests and the complete plugin gate.

## H2 — Enforceable SQL integrity

- Define durable item identity/tombstone semantics so purge audit events and
  projection outbox rows can remain without dangling references.
- Add real SQLite foreign keys for item, revision, source, ACL, relation, event,
  and outbox relationships with explicit delete behavior.
- Provide preview, exact-plan apply, independent postcheck, and rollback-safe
  migration tooling for existing V2 databases.
- Prove orphan inserts fail and a constrained `foreign_key_check` is meaningful.

## H3 — Native retrieval shadow and resource bounds

- Run a real V2 truth/FTS/vector candidate lane alongside the V1 lane.
- Keep both lanes read-only and prevent either from mutating prompt context.
- Record only redacted ids/digests, scope rejection, ranking, latency, timeout,
  and divergence evidence.
- Propagate `AbortSignal` and enforce bounded global/per-session concurrency and
  deduplication so timed-out retrieval cannot continue without limit.

## H4 — Reproducible release identity

- Make a missing or unresolvable live extension fail the release gate unless a
  named, auditable source-only mode is explicitly requested.
- Compare recursive runtime artifact manifests and SHA-256 digests instead of a
  partial handwritten drift list.
- Embed and inspect a candidate build/commit identity independent of SemVer.
- Commit a lockfile, require clean `npm ci`, generate an SBOM/pack manifest, and
  prove a clean-clone build.

## H5 — Recovery, soak, deployment, and fresh decision

- Restore a fresh encrypted live snapshot to an isolated path and verify digest,
  SQLite integrity, constrained foreign keys, and cleanup.
- Deploy only after source/build/live artifact identities match and a rollback
  backup exists outside the plugin discovery path.
- Run real direct/group shadow probes and a bounded soak with zero writes and no
  raw content in traces.
- Re-evaluate promotion debt, native retrieval quality, runtime capability, and
  rollback evidence in a new cutover-or-no-cutover receipt.
- Cutover is not implied by passing earlier stages; a fresh receipt must name
  the exact deployed artifact and current live truth.

## Current acceptance posture

- Existing live Scope Recall 1.1.0: keep serving.
- ClawLore native write/ContextEngine/final recall: `NO-GO` until H1-H5 close.
- Current read-only shadow: allowed while its trace remains redacted and 0600.
