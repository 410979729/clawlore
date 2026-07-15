# Phase 6B default-off runtime composition run — 2026-07-12

## Scope

This isolated slice assembles the previously verified V2 contracts behind a
fixture OpenClaw host boundary. It adds a default-off schema request and proves
the exact conditions under which one read-only shadow observer could be
registered. It does not integrate the root into the live `index.ts`, approve a
live rollout, open a live database, write memory, mutate a prompt, or register a
ContextEngine.

## Runtime contract

- `clawloreV2.mode` defaults to `disabled`; unknown write/cutover values normalize
  to disabled in this slice.
- A shadow request alone is insufficient. Registration requires a ready,
  read-only shadow rollout receipt plus a separately supplied approval whose
  rollout id matches.
- Approved fixture mode registers exactly one low-priority
  `before_prompt_build` observer.
- The observer resolves principal evidence, applies policy before retrieval,
  composes one bounded ContextPack, and persists only a redacted receipt.
- Raw prompt text, memory text, principal ids, conversation ids, and session ids
  are absent from the receipt. Runtime trace ids are opaque hashes.
- Agent tools, memory writes, prompt mutation, services, and ContextEngine
  registration remain disabled.
- Native ContextEngine requests fail closed even when all fixture capabilities
  are advertised.
- Retrieval and trace persistence fail open. The hook returns `undefined` after
  the bounded latency window and cannot block an ordinary answer.

## Verification

- `node --test tests/clawlore-runtime-composition.test.mjs`: 5/5 PASS.
- `npm run smoke:clawlore-runtime-composition`: PASS.
- JSON smoke evidence: default mode disabled; disabled hook count 0; approved
  fixture shadow hook count 1; shadow receipt completed; retrieval invoked;
  selected count 1; tool registrations 0; writes/prompt mutation/ContextEngine
  registration false.
- `npm run smoke:clawlore-module-boundaries`: 2/2 PASS.
- `npm test`: 144/144 PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run smoke:vector-repair`: PASS.
- Golden recall: known-answer recall 1.0; top-k 1.0; forbidden violations 0;
  prompt-budget exceeded 0.
- `npm run release:gate`: PASS; package scan 324 files.

## Cleanup and live boundary evidence

- Removed the generated 330 MB `node_modules` tree after verification; the
  isolated repository is clean and no temporary debug/log files remain.
- State hygiene reports 60 findings outside the project: historical root
  backups/session reset-delete residue plus foreign Codex plugin-cache docs.
  None is a Phase 6B artifact, so they were not deleted under this task.
- `openclaw-gateway-tianji.service` is `active/running`, PID 3914160, with the
  current process started on 2026-07-11 14:38:38 CST; healthz returned
  `{"ok":true,"status":"live"}`.
- The service journal had no entries in the final one-hour window. Live plugin
  `index.ts` and `openclaw.json` mtimes predate this Phase 6B turn.

The initial focused implementation passed. Review then identified two hot-path
risks not covered by the first four cases: a trace sink could throw after the
shadow pipeline caught its own error, and retrieval could remain pending. The
root now timeboxes the observer and converts both outcomes into bounded error
codes while returning no hook mutation. A fifth focused test proves both paths.

## Live boundary and remaining decision

Implementation commit: `cd3612e` (`feat: add default-off runtime composition`).

The isolated release candidate is closed through the fixture-host boundary.
The live extension, configuration, database, existing hooks, ContextEngine slot,
and Gateway were not changed. Connecting this root to live `index.ts`, enabling
even read-only shadow mode, and restarting or hot-reloading the Gateway remain a
separate rollout that requires Joy/operator approval and fresh live inventory,
snapshot, configuration hash, and channel smoke evidence.
