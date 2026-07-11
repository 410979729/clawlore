# Phase 1C — 1.x Security Hardening Run (2026-07-11)

## Scope

Read-only live audit plus an isolated source patch. The live extension,
configuration, database, hooks, and Gateway were not changed.

## Live findings

- The active plugin config has a hosted embedding credential represented as a
  plaintext string.
- `autoBackup`, startup `memoryCompaction.enabled`, and
  `enableManagementTools` are all enabled in the active config.
- The startup compaction path used `dryRun: false` and the legacy backup path
  wrote complete memory text to plaintext JSONL.
- OpenClaw 2026.7.1-beta.2 supports plugin-declared SecretRef contracts through
  `configContracts.secretInputs`; the 1.1.0 manifest did not declare them.
- The current core secrets audit reported 13 plaintext findings, 2 legacy
  residue findings, and no `scope-recall-openclaw` finding. This is a coverage
  gap caused by the missing plugin secret-input contract, not evidence that the
  plugin credential is safe.

No credential value was printed or copied into this report.

## Isolated patch

- Declared SecretRef paths for embedding, rerank, and extraction credentials;
  the JSON schema accepts canonical env/file/exec SecretRef objects.
- Disabled the legacy plaintext JSONL backup scheduler. A configured legacy
  `autoBackup: true` now emits a migration warning without writing data.
- Startup compaction is off unless explicitly set to `dry-run`; the startup
  path cannot apply mutations or record a completed compaction run.
- Agent operator tools require both `enableManagementTools` and the new
  `allowAgentOperatorTools` gate.
- Only playbook search, playbook inspect, and Experience preflight remain
  discoverable by default. Statistics, replay, mutation, repair, governance,
  digest, and dashboard tools stay in the operator surface.

## Verification

- Focused safety/Experience tests: 26/26 PASS.
- TypeScript typecheck: PASS.
- Build: PASS.
- `smoke:clawlore-security-hardening`: PASS.

## Boundary

This run does not migrate the live plaintext credential or change the live
flags. Those actions require a separate rollout plan, config backup, SecretRef
preflight, Gateway validation, and user authorization for the live cutover.
