# Second vertical slice: ContextPack V1 shadow spine

Status: implemented and verified in the isolated repository; not wired to live.

## Input contract

- OpenClaw-shaped runtime identity evidence, including `senderId`, platform,
  account, conversation, thread, and chat type.
- One available-token budget.
- A candidate retrieval callback that must accept an address-derived boundary.
- Candidate memories carrying V2 address, lifecycle, verification, freshness,
  citation, score, confidence, and optional conflict evidence.

## Execution order

1. Resolve `senderId` into a namespaced principal.
2. Fail closed when principal or Agent identity is unresolved.
3. Run automatic-recall policy preflight.
4. Only after preflight passes, invoke retrieval with tenant/principal/Agent and
   visibility-specific conversation, thread, project, customer, or task bounds.
5. Apply lifecycle, verification, reviewed-playbook, per-candidate policy, and
   one shared token budget in the Context Composer.
6. Render one compatibility ContextPack.

## Shadow boundary

The adapter returns `mode: "shadow"`, a would-be rendered ContextPack, and an
explicit stage trace. It deliberately returns no hook mutation. It is not
imported by `index.ts`, does not register `before_prompt_build`, and cannot
alter current recall or prompt assembly.

## Acceptance gates

- Direct sender becomes a private principal boundary.
- Group sender becomes a conversation/thread boundary.
- Missing sender prevents retrieval entirely.
- Cross-principal candidates are rejected before composition.
- Archived/disputed/unreviewed-playbook candidates cannot be injected.
- Selected items share one token budget and one rendered block.
- Recalled text is escaped and labelled as untrusted data.
- Existing full tests, build, golden recall, smoke, and release gate remain green.
