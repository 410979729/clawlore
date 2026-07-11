# ClawLore 2.0 design baseline

Status: RFC, address slice, and ContextPack shadow slice; not wired to live runtime.

This directory is the design truth for the staged transition from
`scope-recall-openclaw` 1.x to ClawLore 2.0.

- `rfc.md`: product and architecture contract.
- `migration-plan.md`: additive migration, shadow comparison, cutover, and rollback.
- `first-vertical-slice.md`: executable Memory Address V2 slice and acceptance gates.
- `second-vertical-slice.md`: ContextPack V1 and compatibility shadow spine.
- `eval/`: dated executable verification reports.
- `adr/`: accepted architecture decisions for Phase 0.

The live extension, live SQLite database, Gateway configuration, package id,
CLI aliases, and ContextEngine slot remain unchanged in this phase.
