# First vertical slice: Memory Address V2

## Scope

This slice implements only types and pure functions:

- `src/v2/domain/memory-address.ts`
- `src/v2/application/identity-resolver.ts`
- `src/v2/application/policy-decision.ts`
- `src/v2/migration/legacy-address-mapper.ts`
- fixture-driven tests and a JSON smoke report

It has no live database dependency and is not imported by `index.ts`.

## Contract

- `senderId` is the raw principal signal; conversation/chat id is the resource
  boundary. They are never substituted for one another.
- Platform/account/sender identities are namespaced unless an explicit,
  auditable identity link supplies a canonical principal.
- Nicknames never resolve identity.
- Missing principal or agent identity fails durable writes closed.
- Private, conversation/thread, and project visibility have distinct boundary
  checks before retrieval or injection.
- Team/global access requires an explicit grant and remains non-injectable in
  automatic mode in this slice.
- Legacy rows missing principal/scope produce review and verification debt.

## Acceptance

- Typecheck passes.
- Fixture unit tests pass.
- Smoke emits JSON only on stdout and returns `PASS`.
- No import from the live plugin entry, no database open, no Gateway restart,
  and no live configuration change.
