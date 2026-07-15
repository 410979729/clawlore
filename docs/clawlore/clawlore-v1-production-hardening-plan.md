# ClawLore v1 production hardening plan

Status: H1-H5 completed on 2026-07-14; final decision `no_cutover`.

## Naming and boundary

ClawLore v1 is the product generation. Existing `V1` / `V2` identifiers remain
internal migration and data-architecture terms. The live package, manifest,
configuration root, CLI aliases, and data path remain on the compatible
`scope-recall-openclaw` 1.x surface until a separately reviewed rename.

Phase 9 closed the original migration roadmap with `no_cutover`; it did not
prove production readiness. This plan closes the independent audit blockers
before any V2 write, native ContextEngine, prompt mutation, or final-recall
cutover can be considered.

## H1 — Mutation authorization and diagnostic privacy — completed (`3a278fd`)

- Route explicit correct/forget through the same address policy used for read
  boundaries, including conversation, thread, and project checks.
- Preserve candidate/observed lifecycle during correction.
- Reject correction of archived/superseded/purged memory until a separate,
  explicit restore operation exists.
- Remove user-derived notes, examples, previews, session names, source ids, and
  actor ids from default doctor JSON.
- Require adversarial regression tests and the complete plugin gate.

## H2 — Enforceable SQL integrity — completed (`6341ac4`)

- Define durable item identity/tombstone semantics so purge audit events and
  projection outbox rows can remain without dangling references.
- Add real SQLite foreign keys for item, revision, source, ACL, relation, event,
  and outbox relationships with explicit delete behavior.
- Provide preview, exact-plan apply, independent postcheck, and rollback-safe
  migration tooling for existing V2 databases.
- Prove orphan inserts fail and a constrained `foreign_key_check` is meaningful.

## H3 — Native retrieval shadow and resource bounds — completed (`90b2c70`)

- Run a real V2 truth/FTS/vector candidate lane alongside the V1 lane.
- Keep both lanes read-only and prevent either from mutating prompt context.
- Record only redacted ids/digests, scope rejection, ranking, latency, timeout,
  and divergence evidence.
- Propagate `AbortSignal` and enforce bounded global/per-session concurrency and
  deduplication so timed-out retrieval cannot continue without limit.

## H4 — Reproducible release identity — completed (`9754d55`)

- Make a missing or unresolvable live extension fail the release gate unless a
  named, auditable source-only mode is explicitly requested.
- Compare recursive runtime artifact manifests and SHA-256 digests instead of a
  partial handwritten drift list.
- Embed and inspect a candidate build/commit identity independent of SemVer.
- Commit a lockfile, require clean `npm ci`, generate an SBOM/pack manifest, and
  prove a clean-clone build.

Acceptance evidence: the isolated reproducibility gate installed from the
committed lockfile, ran 267/267 tests, typecheck and build, generated a
CycloneDX SBOM with 42 components, and removed its temporary source tree. The
source-only release gate separately passed with an explicit no-live-claim
receipt. A nonexistent live target failed closed before any test or smoke.

## H5 — Recovery, soak, deployment, and fresh decision — completed (`71e1659` + final acceptance)

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

Acceptance evidence: a fresh encrypted snapshot restored with matching
logical/schema digests and no plaintext residue; schema 2→3 migrated 1005
identities with enforceable foreign keys and zero violations; candidate and
deployed runtime digests both equal
`c4e43382dbbf09379e51ba1334a8574fcf1369a496f7bb1246cdeb0c455d2251`.
After restart the app-local OpenClaw 2026.7.1-beta.5 surface loaded the exact
extension, the default live release gate passed 267/267 tests and recursive
identity, doctor/schema/privacy checks passed, direct/group shadow fixtures
and all 17 resource-bound regressions passed, and a 50-second 12/12 live soak
added no errors. The fresh decision remains `no_cutover`: active/eligible are
zero, 493 candidate rows remain unverified, 24 archive proposals remain
unapplied, 47 current-content differences remain, and no cutover runtime mode
exists. See
`docs/clawlore/eval/clawlore-v1-h5-production-deployment-run-2026-07-14.md`.

## Final acceptance posture

- Existing compatible Scope Recall 1.1.0 surface: keep serving V1 fallback.
- Hardened ClawLore v1 read-only native shadow: deployed and accepted for
  continued observation while its trace remains redacted and 0600.
- ClawLore native write, lifecycle promotion, ContextEngine, prompt mutation,
  and final recall: `NO-GO` under the fresh H5 receipt.
- A future cutover requires new principal/verification evidence, positive
  native retrieval samples, an implemented cutover mode, and a separately
  authorized decision; H5 completion does not grant that authority.
