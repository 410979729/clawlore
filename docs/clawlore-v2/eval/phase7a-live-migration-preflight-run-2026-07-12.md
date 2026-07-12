# Phase 7A live migration preflight run — 2026-07-12

## Boundary

This round was read-only against the live 1.x SQL truth database. It did not
create V2 tables, enable V2 writes, mutate configuration, register
ContextEngine, change prompt composition, or restart the Gateway. The online
snapshot used for migration planning lived only in a 0700 system temporary
directory and was removed after the redacted receipt was written.

The persisted receipt explicitly records `authorizesV2Writes=false`.

## Implemented

- Added WAL-consistent online snapshot inspection for the legacy
  `memory_truth` schema, including SQLite integrity, foreign keys, schema
  digest, table count, row count, file checksum, and logical truth digest.
- Added verified restore-to-new-location and tamper rejection for legacy
  snapshots.
- Added AES-256-GCM legacy snapshot archive support using the existing 0600
  file SecretRef key provider; plaintext SQLite/WAL/SHM/decrypt residue is
  removed on all paths.
- Added a live migration preflight command that snapshots to a temporary
  location, plans migration only from that copy, rechecks live logical truth
  for concurrent change, emits only aggregate debt counts, and removes the
  temporary plaintext.
- Corrected legacy source classification so nightly digest/summary and
  operational checkpoint sources are not collapsed into unknown legacy rows.
- Added attribution lanes for resolved runtime principals, session-attribution
  review, manual operator review, system-generated review, and unattributed
  quarantine.
- Added a registry-bound session attribution preview. It trusts only exact keys
  present in `sessions.json`, distinguishes direct-principal and conversation
  boundaries, and records `transcriptContentRead=false`.

## Live read-only evidence

The live preflight passed on a verified 1.x copy:

- SQL integrity: `ok`; foreign-key violations: `0`.
- SQL truth rows: `951`; source logical truth was stable before/after preview.
- V2 activation preview: active `0`, candidate `631`, archived `320`.
- Review required: `951/951`; unverified: `874`.
- Source classifications: reflection/summary `412`, auto-capture `197`,
  unknown legacy `206`, explicit manual `77`, operational checkpoint `59`.
- Attribution lanes: system-generated review `298`, session-attribution review
  `382`, unattributed quarantine `194`, manual operator review `77`.
- Session registry coverage: trusted direct principal `77`, trusted
  conversation boundary `15`, unresolved session reference `290`, no session
  reference `569`; total trusted coverage `92/951`.
- Every row currently carries `legacy_identity` debt. The result is therefore
  a no-go for V2 writes, not a migration approval.

The private redacted receipt is stored at:

`workspace/archive/clawlore-live-shadow-20260712_032634/controls/phase7-live-migration-preflight-v3.json`

## Verification

- Legacy live preflight tests: 4/4 PASS.
- Legacy encrypted snapshot test: 1/1 PASS.
- Existing Truth V2 encrypted snapshot tests: 3/3 PASS.
- Full tests: 159/159 PASS.
- Module boundaries: 2/2 PASS.
- Typecheck and build: PASS.
- Vector repair smoke: PASS.
- Golden recall: 1.0; forbidden violations `0`; prompt-budget exceeded `0`.
- Release gate: PASS; pack scan `342` files.
- Persisted receipt mode: `0600`; temporary plaintext residue: none.

## Remaining gates

1. Obtain one real authorized group/conversation ingress sample to close the
   Phase 6D boundary window; the earlier unknown/conversation trace has no
   matching Telegram group ingress evidence and is not accepted.
2. Resolve the session-attribution lane only from verifiable session metadata;
   do not infer identity from text or nicknames.
3. Review the manual lane and keep unattributed rows quarantined.
4. Select an approved persistent SecretRef, then create and restore-test the
   actual encrypted live snapshot.
5. Require a fresh V2-write readiness receipt plus separate operator approval
   before any additive schema or write activation.
