# ClawLore v1 brand and architecture refactoring bundle 1 — 2026-07-17

Status: Linux source gate PASS; source candidate only; no live deployment or
release authorization.

## Decision

The first bounded brand/architecture bundle is accepted on Linux. ClawLore is
the canonical product and runtime identity in current source. Scope Recall
names remain only in compatibility contracts or historical material. The
candidate also has an executable whole-source inventory, hotspot non-growth
budgets, and a legacy-brand non-growth ledger.

This is not completion of the full architecture program. The migration-era
root dependency graph, large composition root, CLI/tool decomposition, storage
facade reduction, `src/v2` convergence, and full comment audit remain later
bounded phases.

## Scope and mutation boundary

Changed only the source candidate repository. This run did not deploy an
extension, edit live OpenClaw configuration, mutate a live database, restart a
Gateway, push a repository, tag a release, or use the Windows work computer.

Canonical source commit:
`f7aaf4e0db79c8ebbbc6214bc935317dd0f2cf74`.

Canonical evidence commit:
`0165239251610f3f8b27fad7128fb6f7753029a5`.

## Architecture finding

The repository is not arbitrary spaghetti: strict TypeScript, SQL-authority
tests, privacy controls, transactional fault tests, migration/rollback gates,
and package/release verification provide strong behavioral control. Structural
debt is nevertheless material. The initial root inventory found nine files
above 1,000 lines and three more above 800. The first whole-source guard found
five additional `src/v2/operator` files above 800 lines, including one at
1,171 lines.

The executable inventory now classifies 174 production TypeScript entries:
172 under `src/`, plus `index.ts` and `cli.ts`. Seventeen current hotspots have
exact non-growth ceilings. Every new TypeScript module has an 800-line maximum.
Existing `src/v2` inward-dependency enforcement remains active. Root modules
are classified by predominant responsibility but are not yet claimed to obey
the target dependency direction.

## Implemented contracts

- Added the detailed phased plan in
  `docs/clawlore/clawlore-v1-brand-architecture-refactoring-plan.md`.
- Added `runtime` as the canonical ClawLore runtime configuration object.
- Retained `clawloreV2` as a deprecated compatibility input. Canonical-only and
  legacy-only input normalize to the same internal contract; identical dual
  input is accepted; conflicting dual input fails before hook registration.
- Moved runtime logs from `clawlore-v2:` to `clawlore:` and changed the vector
  repair temporary prefix to ClawLore.
- Centralized product, plugin, CLI, config-root, and legacy identity constants.
- Made new task-experience and promotion classifications ClawLore-first while
  retaining old persisted Scope Recall task classes.
- Added a source-governance test that rejects unclassified production modules,
  hotspot growth, new over-800-line modules, and legacy branding outside an
  explicit non-growth ledger.
- Updated current identity and operator documentation. Historical reports and
  stable `scope_recall_*` wire ids were not rewritten.

## Verification

Focused bundle tests:

- 33 passed, 0 failed;
- includes canonical identity, runtime config compatibility/conflict behavior,
  task classification, Experience promotion, module boundaries, whole-source
  classification, line budgets, and legacy-brand budgets.

Full Node 24 Linux regression:

- 390 total;
- 388 passed;
- 0 failed;
- 2 platform/condition skips.

Both evidence-write and normal-mode source release gates passed. Their common
stable evidence is:

- strict typecheck and build: pass;
- vector repair smoke: pass;
- deterministic recall: 124/124, MRR 1, NDCG 1, forbidden 0, leakage 0;
- SQLite FTS scale: 200,000 rows / 64 queries, recall 1, leakage 0;
- packed runtime smoke: pass;
- packed LanceDB store/reopen/recall/delete/repair smoke: pass;
- isolated packed OpenClaw CLI smoke: pass;
- official-registry vulnerabilities: 0;
- SBOM: CycloneDX 1.5, 42 components;
- npm pack filename/content scan: 187 files;
- clean candidate state: `dirty=false`.

Release-input identity:
`5ecf31d547f7936a5bdee3d349a056470fea15b6c89e193372f2935b31e506fd`
across 563 tracked release inputs.

Runtime identity:
`363f87ce789c0e7b9ad967d7a8b9b48723d33651e12204532e96a00c022b2dd6`.

The first source-gate attempt intentionally failed because the implementation
was still uncommitted. The next clean attempt reached the final evidence check
and correctly rejected evidence bound to the previous candidate. The canonical
evidence was then regenerated in the gate's evidence-write mode, committed,
and independently rechecked by normal mode. These were sequencing guards, not
ignored test failures.

## Cleanup

The `node_modules` tree rebuilt from the lockfile for verification was removed.
No ClawLore temporary root remained under `/tmp`, and the project worktree was
clean at material HEAD. The state-hygiene audit reported 86 items outside the
project, consisting of host/config backups, session reset/deleted residues, and
Codex plugin-cache documents. They were not candidate artifacts and were left
untouched.

## Remaining boundary

Overall release status remains NO-GO. The next architecture bundles must add a
non-growth exception ledger for migration-era reverse dependencies, extract
configuration/reflection/capture/runtime registration from `index.ts`, split
CLI/tools by capability, reduce storage facades, converge current modules out
of ambiguous product-version naming, and audit public/security/transaction
comments.

Any later release candidate still requires an exact Node 24 Windows source
gate, cleanup and absence verification of only the owned Windows audit roots,
and independent review. Live identity migration remains a separate,
backup-backed and explicitly authorized transaction.
