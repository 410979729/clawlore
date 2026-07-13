# ClawLore 2.0 design baseline

Status: live shadow runtime with hooks registered; writes, ContextEngine,
prompt mutation, lifecycle promotion, and final recall remain disabled. Phase
8E is complete.

This directory is the design truth for the staged transition from
`scope-recall-openclaw` 1.x to ClawLore 2.0.

- `rfc.md`: product and architecture contract.
- `migration-plan.md`: additive migration, shadow comparison, cutover, and rollback.
- `project-handoff.md`: current live position, latest completed phase, and next
  controlled boundary.
- `first-vertical-slice.md`: executable Memory Address V2 slice and acceptance gates.
- `second-vertical-slice.md`: ContextPack V1 and compatibility shadow spine.
- `third-vertical-slice.md`: legacy source adapters and deterministic comparison.
- `eval/`: dated executable verification reports.
- `adr/`: accepted architecture decisions for Phase 0.

The package id and CLI aliases remain compatibility surfaces. Current live
state and mutation boundaries are recorded in `project-handoff.md` and must be
reverified before every later phase.
