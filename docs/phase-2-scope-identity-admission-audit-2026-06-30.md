# Phase 2 Scope, Identity, And Admission Audit - 2026-06-30

Scope: commercial memory plugin plan Phase 2.

## Model And Execution Gate

- Current session model was re-verified before this phase audit:
  `openai/gpt-5.5`.
- Current thinking mode was re-verified as `xhigh`.
- Work stayed inside the existing `scope-recall-openclaw` workspace.

## Changes Audited

Phase 2 added a deterministic runtime identity metadata contract and tightened
capture defaults.

Code changes:

- Added `src/runtime-scope-metadata.ts`.
  - Extracts only known scalar runtime fields.
  - Writes `runtime_contract=openclaw-scope-v1`.
  - Records agent, session, channel, account, conversation, thread, platform,
    workspace, target scope, and scope-filter mode where available.
  - Bounds string and scope-filter sizes.
- Updated `src/tools.ts`.
  - `memory_store` and `memory_store_secret_index` now persist runtime scope
    metadata on created rows.
  - Runtime workspace evidence prefers execute-time context over static
    registration defaults.
  - Foreign scopes are still denied before embedding or storage.
- Updated `src/smart-extractor.ts`.
  - Smart extraction carries runtime metadata through create, profile merge,
    merge fallback, supersede, support, contextualize, contradict, and rejected
    admission audit paths.
- Updated `index.ts`.
  - Auto-capture builds runtime metadata from hook context/event data.
  - Smart extraction and regex fallback both persist the same runtime metadata.
- Updated `src/admission-control.ts`.
  - Rejected admission audit entries can include redacted runtime metadata.
- Updated `src/capture-safety.ts`.
  - Blocks raw tool-call/output dumps, private credential paths, and ephemeral
    assistant progress noise in addition to the existing wrapper, ACK,
    attachment, compaction, and secret gates.

Documentation and gate changes:

- Added `docs/runtime-identity-scope-rules.md`.
- Updated `docs/openclaw-contract-matrix.md` for Phase 2 partial maturity.
- Updated `CHANGELOG.md`.
- Added runtime identity files and markers to `scripts/release-gate.mjs`.

## Verification

Commands already run in this phase:

```bash
node --test tests/capture-safety.test.mjs tests/capture-safety-quality.test.mjs tests/safety-regressions.test.mjs
npm run typecheck
npm run build
```

Results:

- Targeted safety tests passed: 37 passed, 0 failed.
- TypeScript typecheck passed.
- Build passed and generated updated `dist/` files.

## Audit Findings

- Missing OpenClaw agent runtime context still fails closed.
- `memory_store` now stores deterministic runtime metadata and keeps the manual
  source/state/layer semantics unchanged.
- `memory_store` and `memory_recall` both deny an explicit foreign agent scope
  before lower-level retrieval, embedding, or storage work runs.
- Smart extraction-created rows now carry the same runtime scope metadata.
- Capture safety now has tests for raw tool JSON dumps, private credential
  paths, ephemeral progress noise, Chinese credential assignments, wrapper
  blocks, trivial ACKs, attachment-only payloads, and secret-shaped text.
- The new identity contract doc does not contain live secrets or credential
  values.

## Remaining Risk

- This phase is `partial`, not `ready`: live Telegram direct/group/thread/CLI
  and subagent probes still need to be exercised before claiming full runtime
  identity maturity.
- Local scratch promotion is documented as a governance path; full scratch
  isolation still needs a dedicated live/governance probe.
- Gateway was not restarted during this active conversation turn. After live
  file sync, source/live extension parity can be verified, but in-process module
  refresh is not claimed until a reload/restart occurs.
