# Phase 0 Memory Address V2 run — 2026-07-11

## Result

PASS for the isolated first vertical slice. This is not a live rollout result.

## Tested contract

- Telegram direct identity resolves to a platform/account/sender principal.
- Telegram group identity remains conversation/thread scoped.
- A nickname cannot resolve a principal; durable write fails closed.
- Legacy agent rows without sender identity remain review debt.
- Legacy channel rows with sender metadata map to conversation scope.
- Private recall cannot cross principal.
- Conversation recall cannot cross thread.
- Global memory requires an explicit grant and is not automatically injected.

## Evidence

| Check | Result |
| --- | --- |
| Focused V2 unit tests | 8/8 PASS |
| Full plugin tests | 96/96 PASS |
| TypeScript typecheck | PASS |
| Build | PASS |
| Address V2 JSON smoke | PASS; 0 unsafe unresolved writes |
| Existing vector-repair smoke | PASS through release gate |
| Golden recall benchmark | PASS; known-answer recall 1.0; forbidden violations 0 |
| Release gate | PASS; pack scan 222 files |

The first dependency install initially omitted dev dependencies because the
execution environment sets `NODE_ENV=production`. Rerunning
`npm ci --include=dev` restored the already-declared TypeScript dependency;
no package dependency change was needed.

## Boundaries verified

- The new modules are not imported from `index.ts`.
- No live database was opened or migrated.
- No live extension or OpenClaw configuration was edited.
- No ContextEngine slot was selected and Gateway was not restarted.

## Environment note

Post-run state hygiene audit reported 52 pre-existing findings outside the
workspace project: historical session reset/deleted residues, two root-level
OpenClaw configuration backups, and foreign canonical docs inside Codex plugin
caches. None was created or modified by this slice. They were left untouched
because cleanup is a separate state-governance task. The generated project
`node_modules` tree was removed after verification; committed `dist` output and
the run report were retained as build and audit artifacts.

## Next recommended slice

Define ContextPack V1 and a pure compatibility Context Composer, then add a
runtime adapter test proving sender identity reaches policy before retrieval.
Keep live integration behind a disabled feature flag until shadow traces pass.
