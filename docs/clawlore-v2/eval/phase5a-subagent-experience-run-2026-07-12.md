# Phase 5A subagent and Experience lifecycle run — 2026-07-12

## Scope

This isolated slice implements the ClawLore V2 subagent/Experience lifecycle as
separate domain, application, storage, and OpenClaw adapter modules. It does not
activate the native ContextEngine slot or register new Agent tools.

## Implemented contract

- `isolated` snapshots contain only explicitly authorized non-private items.
- `fork` snapshots contain the bounded parent ContextPack as a read-only copy.
- Child scratch rejects durable retention and secret-shaped content; accepted
  scratch remains candidate-only with ephemeral or working retention.
- Child completion atomically revokes the active snapshot and creates one
  candidate episode. Duplicate completion and late scratch writes fail closed.
- Parent verification requires the owning parent session, a successful outcome,
  tool receipts, and evidence. Failure/blocked/incomplete results cannot become
  verified success.
- Playbook candidates require parent-verified successful episodes owned by the
  same parent actor, task class, and scope.
- A single successful run cannot promote a playbook without explicit operator
  review; two distinct verified run ids may satisfy repeated-evidence policy.
- Promoted playbooks support negative-feedback quarantine and versioned
  supersede lineage. The predecessor records the successor id.
- Replay is evaluative, not production verification. It passes only for a
  promoted, scope-matching playbook with all tools, prerequisites, steps, and
  verification gates present and no disabled steps.

## Verification

- `npm run smoke:clawlore-subagent-experience`: 2/2 PASS.
- `npm run smoke:clawlore-module-boundaries`: 2/2 PASS.
- `npm test`: 136/136 PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run smoke:vector-repair`: PASS.
- Golden recall: known-answer recall 1.0; top-k accuracy 1.0; forbidden
  violations 0; prompt budget exceeded 0.
- `npm run release:gate`: PASS; pack scan 311 files.

The first typecheck rejected a direct experimental `node:sqlite` type import;
the adapter now follows the existing runtime `createRequire` boundary. A later
review found that completed snapshots remained active and playbook evidence was
not bound to the owning parent actor. Snapshot revocation plus episode creation
is now one SQLite transaction, and ownership is checked before candidate
creation. All gates were rerun after both repairs.

## Live boundary

No live extension, configuration, database, hooks, ContextEngine slot, or
Gateway service was changed or restarted.

## Next slice

Build the compatibility/release bundle: stable V2 response schemas, alias and
deprecation matrix enforcement, additive install/cutover/rollback dry-runs,
support-bundle redaction, and an explicit default-off rollout manifest.
