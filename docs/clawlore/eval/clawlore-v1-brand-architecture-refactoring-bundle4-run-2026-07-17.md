# ClawLore v1 brand and architecture refactoring bundle 4 — 2026-07-17

Status: evidence-write Linux source gate PASS; normal-mode verification
pending; source candidate only.

## Decision

The auto-capture policy and bounded conversation-state slice is accepted at
the code and first Linux evidence boundary. Regex compatibility policy no
longer lives in the entry point, and cross-hook ingress/history state has one
owner with characterization tests. No reverse-dependency exception was added.

This does not extract the complete capture use case. Runtime access, scope and
metadata resolution, rate limiting, low-value filtering, compression, smart
extraction, dedupe, persistence, Markdown dual-write, logging, and hook
registration remain in `index.ts` for later bounded slices.

## Scope and mutation boundary

Changed only the source candidate repository. This round did not deploy an
extension, edit live OpenClaw configuration, mutate a live database, restart a
Gateway, connect to the Windows work computer, push, tag, or release.

Code commit:
`95047a731a80e28b4ce60e47ec72f763d93784c7`.

Stable plan commit:
`ea82afe9dd9bef3c99c21238df47133a5f777858`.

## Extracted boundaries

- `src/auto-capture-policy.ts` owns compatibility regex signals, management
  exclusions, safety preflight, and category classification. `index.ts`
  preserves the existing public `shouldCapture` and `detectCategory` exports.
- `src/auto-capture-session-state.ts` owns ingress/session-key alignment,
  normalized user and optional-assistant message extraction, pending-ingress
  consumption, per-session history cursors, explicit-remember context carry,
  and bounded state eviction. It cannot resolve access or scope, call a model,
  or persist memory.
- `index.ts` composes the state object, performs access checks before ingress
  recording, and retains the remaining capture use case and hook ownership.

The entry point fell from 3,336 to 3,105 lines. The new production modules are
75 and 175 lines, both below the 800-line ceiling. The executable hotspot
ceiling is now 3,105 and the 45-edge reverse-dependency debt ledger did not
grow.

## Correctness finding

The old cursor narrowed history only when the normalized snapshot length was
strictly greater than the previous count. A repeated agent-end delivery with
the same snapshot therefore selected the entire history again. The extracted
state treats an equal-length snapshot as zero new texts, still selects only the
growth suffix, and treats a shorter reset/compacted snapshot as new input.

One initial policy test used `Call me Joy` as an entity fixture even though the
existing compatibility regex classifies only its established `is called` /
Chinese-addressing forms as entities. The fixture was corrected; production
classification was not broadened to make the test pass.

## Characterization coverage

The focused 15/15 set covers:

- canonical English and Chinese capture signals;
- management, secret, summary, emoji-heavy, and trivial rejection;
- compatibility category mapping;
- ingress/session suffix alignment without collapsing colon-delimited threads;
- user, optional-assistant, text-block, and rejected-message handling;
- one-shot pending ingress and repeated-snapshot zero increment;
- history growth and explicit-remember prior-context carry;
- independent map bounds without exposing captured text;
- source classification, hotspot non-growth, reverse-dependency non-growth,
  and legacy-brand budgets.

## Verification

Pre-commit focused tests: 15 passed, 0 failed.

Full Node 24 Linux regression:

- 411 total;
- 409 passed;
- 0 failed;
- 2 platform-condition skips.

Evidence-write Linux source gate on `ea82afe`:

- strict typecheck and build: pass;
- vector repair smoke: pass;
- deterministic recall: 124/124, MRR 1, NDCG 1, forbidden 0, leakage 0;
- SQLite FTS scale: 200,000 rows / 64 queries, recall 1, leakage 0;
- packed runtime smoke: pass;
- packed LanceDB store/reopen/recall/delete/repair smoke: pass;
- isolated packed OpenClaw CLI smoke: pass;
- official-registry vulnerabilities: 0;
- SBOM: CycloneDX 1.5, 42 components;
- npm pack filename/content scan: 194 files;
- clean candidate state: `dirty=false`.

Release-input identity:
`3cbe4c38c7dc132dd8ade2195358d3baa9ea9bb7c0dd60e0e08967ebf339fc02`
across 584 tracked inputs.

Runtime identity:
`e25fbe07227cd148da6ba1e28d90402a0646fd48be027d5f4fe4a56f56271df8`.

Normal mode must compare a clean evidence commit against these stable fields
before bundle closure.

## Cleanup and remaining boundary

Cleanup and state-hygiene results are pending final normal-mode verification.
Overall release status remains NO-GO. The next bounded entry-point slice is
Markdown compatibility retrieval; it must not include runtime construction,
capability hook registrars, storage convergence, or live rollout.
