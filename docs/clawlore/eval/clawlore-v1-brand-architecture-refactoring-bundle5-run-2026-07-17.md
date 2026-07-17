# ClawLore v1 brand and architecture refactoring bundle 5 — 2026-07-17

Status: architecture closure reached; evidence-write and normal-mode Linux
source gates PASS; ready for independent source audit; source candidate only.

## Decision

Phases C through G of the architecture plan are accepted at the source-candidate
boundary. ClawLore now has a thin composition root, capability-oriented CLI and
Agent tools, explicit MemoryStore ports/facade, canonical current-product
application/OpenClaw adapter roots, a compatibility removal ledger, and a
comment/contract audit.

This is ready for independent source review. It is not release-ready or live-
rollout authorization: the exact Windows Node 24 gate, owned Windows audit-root
cleanup, and independent review remain open.

## Commits and scope

- architecture code and compiled output: `d50fd4e`;
- stable audit-boundary documentation: `dadc202`;
- release gate split-CLI source audit: `961d2e6`;
- source/compiled CLI package-version resolution: `56bce74`.

Only the source candidate repository and its project ledgers changed. This
bundle did not deploy an extension, edit live OpenClaw configuration, mutate a
live database, restart a Gateway, connect to the Windows work computer, push,
tag, or release.

## Structural outcome

- `index.ts`: 3,105 to 632 lines, versus the original 4,730-line baseline;
- `cli.ts`: 2,794 to 198 lines;
- `src/tools.ts` and `src/experience-tools.ts`: stable export facades over
  capability modules;
- new production modules: all at or below the 800-line ceiling;
- reverse-dependency exception ledger: 45 to 44 edges;
- `MemoryStore`: compatibility constructor/facade over truth, retrieval,
  projection, and transaction ports;
- stable application/OpenClaw adapter implementations relocated from `src/v2`
  to canonical roots; old paths are tested deprecated re-export shims.

Inherited implementation hotspots remain visible and shrink-only. The largest
are `src/store.ts` (2,010), `src/sql-truth-store.ts` (1,514),
`src/smart-extractor.ts` (1,427), `src/retriever.ts` (1,425), and
`src/embedder.ts` (1,309). Audit-ready therefore means the planned structural
scope is closed and mechanically governed, not that all technical debt is gone.

## Characterization and contract coverage

New or strengthened tests cover Markdown path containment, store-port
delegation, exact tool/Experience facade exports, canonical-versus-versioned
imports, deprecated-shim purity, CLI version resolution, module classification,
hotspot non-growth, reverse-dependency non-growth, legacy-brand budgets, and
split-CLI release policy scanning.

The final full Linux regression contained 418 tests: 416 passed, 0 failed, and
2 platform-condition tests skipped. The exact Windows tests were not run or
claimed on Linux.

## Gate defects found and closed

The first evidence-write attempt failed before product tests because the
release gate still searched only `cli.ts` for doctor/operator markers. The
production commands had moved correctly; gate policy had not. Commit `961d2e6`
audits the complete fixed CLI source set and adds a regression.

The second attempt passed tests, build, recall, scale, and two packed smokes,
then failed the installed-tarball `clawlore version` smoke. The split policy
module still searched package paths relative to the former root module. Commit
`56bce74` supports both source and compiled layouts and verifies the compiled
lookup returns `1.2.0`.

Both attempts remain failures. Only the complete third run below is acceptance
evidence.

## Evidence-write Linux source gate

Exact source candidate: `56bce74c804c3d7c40fe8bfe1e43c8e009f2469e`.

- full regression: 418 total / 416 passed / 0 failed / 2 skipped;
- strict typecheck and build: pass;
- vector-repair smoke: pass;
- deterministic recall: 124/124, MRR 1, NDCG 1, forbidden 0, leakage 0;
- SQLite FTS scale: 200,000 rows / 64 queries, recall 1, leakage 0;
- packed runtime smoke: pass;
- packed LanceDB store/reopen/recall/delete/repair smoke: pass;
- isolated packed OpenClaw CLI activation/doctor/three command-version smoke:
  pass;
- official-registry vulnerabilities: 0;
- SBOM: CycloneDX 1.5, 42 components;
- npm pack filename/content scan: 239 files;
- clean candidate state: `dirty=false`.

Release-input identity:
`6f7edcc2692f8e718b3e0bda6682975a408641ea4354f8ce528af79cef908e27`
across 680 tracked inputs.

Runtime identity:
`40d827230c0d2e7c48fbe364228eaf69739a75862acb983bfb24a8c3e3cbeb69`.

The canonical machine evidence is
`eval/clawlore-v1-release-evidence.json`.

## Normal-mode evidence verification

Evidence commit `22f2887fe1c4214c8f9bf4226fd6d09cba759823` repeated the complete
source gate in normal mode. It again passed 418 total / 416 passed / 0 failed /
2 skipped, typecheck, build, vector repair, 124/124 recall, the 200,000-row FTS
baseline, all three packed smokes, a 42-component SBOM, a 239-file package
scan, and official-registry vulnerabilities 0.

The normal run recomputed release-input identity `6f7edcc2…` and runtime
identity `40d82723…` exactly. The observed commit and SBOM digest varied only in
the explicitly permitted evidence fields; stable evidence comparison passed.

## Remaining boundary

Architecture status is AUDIT-READY. Release/live status is NO-GO. Next action
is independent source audit plus the
separate exact Windows gate when the authorized work computer is reachable.
No compatibility alias, persisted protocol version, live config, live database,
or extension installation is removed or changed by this closure.
