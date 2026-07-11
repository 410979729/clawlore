# Runtime Maturity Audit - 2026-06-25

This note supersedes the version facts in the 2026-06-09 Hermes parity audit.
That older audit remains useful as historical release context, but it should not
be used as the current runtime truth for Tianji.

## Evidence Checked

- OpenClaw Gateway service:
  `openclaw-gateway-tianji.service` was loaded, active, and listening on
  `127.0.0.1:19021` during this audit.
- Plugin inspect:
  `openclaw plugins inspect scope-recall-openclaw` reported
  `Status: loaded`, source under Tianji's live extension directory, and version
  `1.0.23`.
- Workspace and live extension manifests:
  `package.json` and `openclaw.plugin.json` both reported `1.0.23` in both
  the workspace tree and the live extension tree.
- Doctor:
  `openclaw scope-recall doctor --json --quiet` reported SQL truth, FTS, and
  vector companion healthy with `762` SQL truth rows and no missing or stale
  vector rows.

## Current Runtime State

- Memory truth: `762` total rows in SQL truth.
- Governance cleanup: a dry run found `235` soft-archive candidates and `0`
  hard-delete candidates. After backup, a reversible cleanup archived those
  `235` low-value operational-trace rows. The active-row count moved from
  `677/762` to `442/762`, and a follow-up report found no remaining soft
  archive, hard delete, or duplicate candidates.
- Experience Kernel: schema is ready and dynamic tools are present, but runtime
  proof is still early. This audit created the first task episode; there are
  still no procedural playbooks, playbook versions, or recorded playbook runs.
- Nightly digest: the OpenClaw-native digest table is present with `27`
  successful runs. This is not full Hermes journal-first workflow capture.
- Journal recovery: the compatibility layer is present in the package, but
  OpenClaw deployments without the expected journal runtime tables should still
  report an unsupported or no-candidates state rather than claiming Hermes-style
  journal replay parity.

## Remaining Gaps Against Yuheng Hermes Runtime

- Entity probe, related lookup, and feedback tools remain roadmap items.
- Full journal-first capture and Hermes shared/local scope semantics are not
  claimed for OpenClaw.
- Experience Kernel needs real repeated production use: promoted playbooks,
  replay checks, feedback, and successful run history.
- Runtime tool exposure should be verified with live tool discovery before
  claiming a specific operator surface is available in a given session.

## Operating Rule

Use this document for current 2026-06-25 Tianji runtime maturity context. Use
`hermes-parity-audit-2026-06-09.md` only as a historical comparison against the
older `1.0.11` / Hermes `1.0.9` release line.
