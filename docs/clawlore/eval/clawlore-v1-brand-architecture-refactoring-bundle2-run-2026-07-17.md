# ClawLore v1 brand and architecture refactoring bundle 2 — 2026-07-17

Status: Linux source gate PASS; source candidate only; no live deployment or
release authorization.

## Decision

The second bounded architecture bundle is accepted on Linux. Migration-era
root dependencies now have an executable shrink-only debt ledger, and the
first `index.ts` composition slice has moved validated plugin configuration
into a named module without changing its observed contract.

This is not completion of the thin composition root. Reflection, capture,
Markdown compatibility retrieval, runtime construction, and hook registration
still remain in `index.ts`. CLI/tools/storage decomposition, architecture-
generation convergence, Windows acceptance, and independent review also remain
open.

## Scope and mutation boundary

Changed only the source candidate repository. This run did not deploy an
extension, edit live OpenClaw configuration, mutate a live database, restart a
Gateway, connect to the Windows work computer, push a repository, tag, or
release.

Code commit:
`5d3606e46479310f97a1833e45dd81f250837ce5`.

Complete source/plan candidate observed by canonical evidence:
`9e0fcfa3705dfb3fab96b7dee001ca65dd3e5839`.

## Reverse-dependency finding

The root scan found 137 internal imports and 45 reverse edges:

- application → infrastructure: 19;
- application → operator: 7;
- adapters → infrastructure: 8;
- adapters → operator: 4;
- infrastructure → operator: 6;
- domain → infrastructure: 1.

Four targets explain most of the debt: `diagnostic-redaction.ts` has 14 incoming
reverse edges, `store.ts` 11, `embedder.ts` 6, and `llm-client.ts` 5. The exact
edge list is enforced by `tests/clawlore-source-governance.test.mjs`; new debt
fails immediately, and removed debt must delete its ledger entry in the same
change. Human interpretation and remediation order are documented in
`docs/clawlore/root-module-dependency-debt-v1.md`.

## Configuration extraction

- Added `src/plugin-config.ts` as a 556-line composition-support module.
- Moved the validated `PluginConfig` contract, numeric helpers, reflection
  defaults, credential-shape validation, privacy-first defaults, legacy session
  compatibility, and runtime config resolution into that module.
- Preserved `parsePluginConfig` as a public export from `index.ts`.
- Reduced `index.ts` from 4,730 to 4,184 lines and lowered its executable
  non-growth ceiling accordingly.
- Added four dedicated configuration characterization tests.
- Compared old and new parsers before cutover across five valid and four invalid
  fixtures; normalized results and error messages matched exactly.
- Updated the MiniMax source assertion to follow parsing into the new module
  while still proving forwarding and request emission.

## Verification

Focused architecture/configuration/security set:

- 43 passed, 0 failed.

Full Node 24 Linux regression:

- 395 total;
- 393 passed;
- 0 failed;
- 2 platform-condition skips.

Evidence-write and normal-mode Linux source gates:

- strict typecheck and build: pass;
- vector repair smoke: pass;
- deterministic recall: 124/124, MRR 1, NDCG 1, forbidden 0, leakage 0;
- SQLite FTS scale: 200,000 rows / 64 queries, recall 1, leakage 0;
- packed runtime smoke: pass;
- packed LanceDB store/reopen/recall/delete/repair smoke: pass;
- isolated packed OpenClaw CLI smoke: pass;
- official-registry vulnerabilities: 0;
- SBOM: CycloneDX 1.5, 42 components;
- npm pack filename/content scan: 188 files;
- clean candidate state: `dirty=false`.

Canonical evidence commit:
`974c04a55e05aa89de52ccabdfa56953a1609228`.

Normal mode re-ran the complete gate from that clean commit. Stable
release-input and runtime identities matched the checked-in evidence; only the
contract's declared observed-commit/SBOM toolchain variance changed.

Release-input identity:
`074832cb1cf41436e0511c4a691d9f16c0f5ca203e59989b701ca538476ef1a0`
across 567 tracked release inputs.

Runtime identity:
`4f31de8b1a782726f785ee78bdb08059d9d57347aee0ea1a3badf989b4e81350`.

## Cleanup and remaining boundary

The lockfile-built `node_modules` tree was removed after normal-mode evidence
verification. `/tmp` contained no ClawLore-named residue, and the project
worktree was clean. The workspace state-hygiene audit reported 86 items outside
the project: historical config backups, session reset/deleted artifacts, and
host-managed plugin-cache documents. They were not created by this bundle and
were left untouched.

Overall release status remains NO-GO. The next bounded slice should extract
reflection transcript reading and orchestration under characterization tests;
it must not mix in capture, storage, live rollout, or a product release.
