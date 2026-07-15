# Phase 1B legacy-source shadow run — 2026-07-11

## Result

PASS for the isolated legacy source adapters and deterministic ContextPack
comparison. This is not a live rollout result.

## Delivered bundle

- Read-only adapters for auto recall, inherited reflection rules, derived focus,
  and error reminders.
- Deterministic legacy block renderer covering the three existing hook outputs.
- Legacy-to-ContextPack comparison with candidate preservation, explicit policy
  rejection, source traces, and no hook mutation.
- Fixed fixture, six focused tests, and machine-readable JSON smoke.

## Evidence

| Check | Result |
| --- | --- |
| Focused legacy-source/comparison tests | 6/6 PASS |
| Full plugin tests | 108/108 PASS |
| TypeScript typecheck | PASS |
| Build | PASS |
| Legacy shadow JSON smoke | PASS; 3 hook outputs -> 1 ContextPack |
| Determinism | PASS; repeated result structurally identical |
| Safe fixture preservation | PASS; 5/5 selected; 0 unexplained rejection |
| Address V2 and ContextPack V1 smokes | PASS |
| Existing vector-repair smoke | PASS |
| Golden recall benchmark | PASS; known-answer recall 1.0; forbidden violations 0 |
| Release gate | PASS; pack scan 243 files |

## Negative-path proofs

- A legacy private row without sender evidence mapped to identity debt and was
  rejected with `private_principal_mismatch`.
- A task-experience-shaped playbook without tool/operator verification was
  rejected at `playbook_review`.
- Reflection sources above the current six-line cap were truncated with an
  explicit adaptation warning.
- The comparison returned `mode: shadow` and no hook result.

## Comparison scope

The shadow comparison proves candidate identity, section mapping, policy
decisions, budgeting, and deterministic output. It does not claim byte parity
between legacy prompt text and ContextPack text; byte parity would preserve the
very multi-block behavior this phase is designed to replace.

## Boundaries verified

- The new adapters are detached from `index.ts`.
- No live extension, configuration, database, session store, or provider was
  read or changed.
- No current `before_prompt_build` hook was replaced or registered.
- No ContextEngine slot was selected and Gateway was not restarted.

## Next recommended round

Perform the separate 1.x safety-hardening audit for SecretRef schema support,
plaintext auto-backup, startup compaction, and management-tool discovery before
considering a default-off runtime shadow flag. Keep any fixes isolated from the
2.0 architecture branch unless they are required compatibility contracts.
