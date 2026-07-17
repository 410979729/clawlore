# ClawLore v1 comment and contract audit

Status: architecture-closure review complete for the changed public,
security, compatibility, lifecycle, and transaction boundaries.

The standard is information value, not comment density. A comment is required
when types and names cannot carry a trust boundary, ordering constraint,
compatibility reason/removal condition, lifecycle invariant, or caller-visible
contract. Comments that restate code or preserve stale phase language are not
accepted as quality evidence.

## Reviewed closure boundaries

| Boundary | Evidence | Result |
|---|---|---|
| Tool and Experience facades | Exact runtime export lists in `tests/public-module-contract.test.mjs`; shared policy modules retain authorization and redacted-error behavior. | Public surface preserved; no accidental internal registrar export. |
| CLI facade and capability modules | Existing command-shape and release-gate tests scan the capability modules; metadata initialization remains lazy. | Command/response contract preserved; policy has one owner. |
| Store facade and ports | `src/memory-store-ports.ts`, `src/memory-store-facade.ts`, and `tests/memory-store-facade.test.mjs`. | Compatibility construction and optional injection are documented; transaction semantics remain in the runtime implementation. |
| Markdown compatibility | `src/markdown-compat.ts` and `tests/markdown-compat.test.mjs`. | Path-containment and compatibility intent are explicit and tested; no broad filesystem contract is implied. |
| OpenClaw hook registrars | Capability-specific hook modules plus composition tests. | Lifecycle ownership is visible in module names/types; non-obvious session/retry constraints retain comments where needed. |
| Relocated current-product modules | `src/application`, `src/adapters/openclaw`, and deprecated `src/v2` shims. | Every shim states deprecation and canonical target; actual protocol versions remain named. |
| Security/authorization policy | Shared CLI/tool runtime policy modules and existing safety regressions. | Fail-closed checks and operator-only discoverability were moved intact, not duplicated. |
| SQL/transaction/rollback logic | Store implementation and existing authority, transaction-fault, privacy, vector-repair, and restart suites. | No transaction algorithm was rewritten in this closure; existing ordering/rollback comments and tests remain authoritative. |

## Findings

1. The former hotspot files mixed policy and registration so heavily that a
   reader could not tell whether a block was public adapter code or business
   logic. Capability extraction, not extra prose, was the correct fix.
2. `MemoryStore` needed an explicit architectural contract. The new port names
   make truth, retrieval, projection, and transaction ownership inspectable;
   the compatibility facade comment explains why the old constructor remains.
3. The relocated `src/v2` modules needed removal semantics. Pure deprecated
   re-export shims now make the compatibility boundary mechanically testable.
4. Stable `scope_recall_*` identifiers and actual V1/V2 protocol names must not
   be “cleaned up” by comment-only branding edits; their reason and removal
   gates belong in the compatibility ledger.
5. No missing comment justified delaying the source audit. Remaining large
   files are structural debt controlled by line/reverse-dependency budgets,
   not something that can be repaired with decorative comments.

## Audit rule for future changes

Any change to authorization, filesystem containment, OAuth privacy, SQL
authority, transaction ordering, rollback, hooks, public command/tool shape,
or compatibility fallbacks must update or add a focused regression. If a new
comment makes a behavioral claim without such evidence, the claim is not
accepted. Historical evidence reports remain immutable except for factual link
corrections.
