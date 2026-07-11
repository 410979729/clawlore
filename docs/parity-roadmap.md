# OpenClaw And Hermes Parity Roadmap

`scope-recall-openclaw` and Hermes `scope-recall` share the same memory philosophy, but they live in different runtimes. This document prevents accidental over-claiming and gives maintainers a concrete parity map.

## Current OpenClaw Strengths

- OpenClaw dynamic memory tools.
- OpenClaw CLI commands with `scope-recall` and `memory-pro` aliases.
- SQLite truth plus FTS diagnostics.
- Rebuildable LanceDB vector companion.
- Native-free `sqlite-bruteforce` vector companion fallback.
- Degraded no-key `local-hash` embedding fallback.
- Read-only OpenClaw inspection tools: `memory_context` and `memory_inspect`.
- OpenClaw-native `memory_govern` review candidates for conflict-review rows,
  local/working scratch, legacy rows, inactive lifecycle rows, archived rows,
  and low-confidence auto-capture candidates.
- Dry-run-first `scripts/migrate-legacy-hygiene.mjs` for backup-backed SQLite
  hygiene migration of legacy scratch and missing durable metadata.
- Hermes 1.0.13-style conflict posture: contradiction evidence is linked for
  review and does not automatically hide older memories.
- Capture safety for common secret patterns.
- Auto-recall, auto-capture, session reflection, and self-improvement hooks for OpenClaw sessions.
- Release gate for manifest/package consistency and package hygiene.
- Partial OpenClaw-native adoption of Yuheng 1.6.0 operator concepts: dashboard,
  candidate promotion, governance cleanup/rollback/audit coverage, journal
  recovery, graph hygiene, forgetting report/run, Experience stats/promotion,
  and playbook review/promotion/quarantine/supersede routes.

## Hermes-Only Surfaces Not Yet Claimed

These are roadmap candidates, not current OpenClaw guarantees:

- Entity probe, related entity, and feedback tools.
- Broader export flows beyond the existing OpenClaw JSON import/export and
  golden recall fixture runner.
- Commercial Recall Funnel traces, fact freshness, relation-aware recall, and
  production-grade benchmark gates.
- OpenClaw-native nightly workflow digest/productized long-term memory
  distillation.
- Hermes-specific shared durable versus local scratch scope semantics.
- Hermes memory-provider packaging through `pyproject.toml` and `plugin.yaml`.

For historical gap analysis against Yuheng's Hermes `scope-recall` `1.0.9`,
see [`hermes-parity-audit-2026-06-09.md`](hermes-parity-audit-2026-06-09.md).
For Tianji's current 2026-06-25 runtime maturity evidence on the
`scope-recall-openclaw` `1.0.23` baseline, see
[`runtime-maturity-audit-2026-06-25.md`](runtime-maturity-audit-2026-06-25.md).
The 2026-06-30 `1.0.25` line carries Yuheng `scope-recall` `1.6.0` safety
semantics for dry-run-first vector repair and SQLite busy timeouts. The
`1.0.26` line adds a partial OpenClaw-native operator CLI adoption for
governance, journal recovery, graph hygiene, candidate promotion, dashboard,
forgetting, Experience, and playbook maintenance routes. It is not full
Yuheng/Hermes 1.6.0 feature parity.

For Tianji's 2026-06-30 partial-parity baseline and commercial-memory starting
point, see [`runtime-maturity-audit-2026-06-30.md`](runtime-maturity-audit-2026-06-30.md).
The follow-on commercial product plan is
[`commercial-memory-plugin-plan-2026-06-30.md`](commercial-memory-plugin-plan-2026-06-30.md).

## Promotion Criteria

Before claiming first-class parity with Hermes `scope-recall`, or before using
commercial-grade language for OpenClaw-native memory behavior, the OpenClaw
package should have:

- User-facing docs for every supported tool and command.
- Tests for package metadata, capture safety, CLI registration, vector repair, and migration.
- CI that runs tests and release gate on every push and pull request.
- A signed-off package tarball inspection showing no `node_modules`, databases, logs, backups, or credentials.
- Live doctor output showing SQL truth, FTS, and vector companion are healthy on at least one OpenClaw instance.
- Native-free vector fallback tests for hosts where LanceDB cannot load safely.
- Documented degraded/offline embedding fallback tests.
- Scope-isolation tests that prove local scratch rows do not bleed between OpenClaw chats, threads, users, or agent identities.

## Non-Goals

- Do not copy Hermes implementation files directly into OpenClaw.
- Do not preserve API names that do not map cleanly to OpenClaw.
- Do not trade current runtime stability for superficial file-count parity.
