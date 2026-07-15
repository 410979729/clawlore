# Third vertical slice: legacy source adapters and shadow comparison

Status: implemented and verified in the isolated repository; not wired to live.

## Sources represented

1. Auto-recall memories currently rendered as `<relevant-memories>`.
2. Reflection invariants currently rendered as `<inherited-rules>`.
3. Derived focus and recent tool-error reminders currently returned together by
   the third `before_prompt_build` hook.

The adapters accept already-loaded, read-only source data. They do not open the
legacy store, call embedding/rerank providers, register hooks, or mutate session
state.

## Adaptation contract

- Auto-recall rows receive a read-only Memory Address V2 preview.
- Legacy identity/scope debt remains visible and is not silently confirmed.
- Profile, decisions, task context, project facts, and explicitly identified
  playbooks map into typed ContextPack sections.
- Inherited rules are demoted from behavioral instructions to untrusted,
  unverified context data.
- Derived focus remains ephemeral task context.
- Tool error signals remain ephemeral, tool-verified task context.
- Existing six-line reflection caps are explicit in adaptation traces.

## Comparison contract

The deterministic comparison records:

- legacy hook-output count and block tags;
- candidate count after source adaptation;
- selected candidate ids and explicit rejection reasons;
- unified ContextPack count and budget outcome;
- a would-be rendered ContextPack with no hook mutation.

Candidate-id preservation is the comparison unit. Rendered legacy text and the
new ContextPack are intentionally not byte-equal because the new renderer
escapes memory markup, labels all recalled content as untrusted data, and uses
one shared budget.

## Acceptance gates

- The fixture produces three legacy hook outputs and one ContextPack.
- Five safe fixture candidates remain selected with zero unexplained drops.
- Repeated runs are structurally identical.
- Missing legacy sender identity is rejected by V2 policy.
- Unreviewed legacy playbooks are rejected.
- Source caps and warnings are deterministic.
- No hook result, live read, provider call, or mutation is produced.
