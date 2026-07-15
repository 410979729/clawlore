# ClawLore v1 architecture baseline

Status: live shadow runtime with hooks registered; writes, ContextEngine,
prompt mutation, lifecycle promotion, and final recall remain disabled. Phase
H5 is complete.

This directory is the design truth for ClawLore v1. Internal `V2` names refer
to the second-generation data architecture, not to the product version. The
canonical product identity is `clawlore`; the former `scope-recall-openclaw`
identity is retained only at documented compatibility boundaries.

- `rfc.md`: product and architecture contract.
- `migration-plan.md`: additive migration, shadow comparison, cutover, and rollback.
- `project-handoff.md`: current live position, latest completed phase, and next
  controlled boundary.
- `first-vertical-slice.md`: executable Memory Address V2 slice and acceptance gates.
- `second-vertical-slice.md`: ContextPack V1 and compatibility shadow spine.
- `third-vertical-slice.md`: legacy source adapters and deterministic comparison.
- `eval/`: dated executable verification reports.
- `adr/`: accepted architecture decisions for Phase 0.

The identity transition and compatibility surfaces are defined in
`identity-transition-v1.md`. Current live state and mutation boundaries are
recorded in `project-handoff.md` and must be reverified before every later phase.
