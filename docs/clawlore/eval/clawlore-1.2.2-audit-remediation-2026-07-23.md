# ClawLore 1.2.2 audit remediation — 2026-07-23

## Decision

This source-only remediation starts from the verified P8 1.2.2 candidate
`1df27e1f9af7bcf9398e14f84d682872f70cd099`. It combines the live/data
coverage from the Tianxuan deep audit, the executable fault probes from the
twenty-second independent review, and the remaining source risks from the
Tianshu round-20 audit.

It does not modify the live extension, OpenClaw configuration, cron jobs,
credentials, memory databases, Gateway process, or canonical remote.

## Source remediations

- Projection workers now acquire a bounded, cross-process mutation fence and
  revalidate their lease after acquiring it. A stale worker cannot overwrite a
  correction, archive, or purge applied by a takeover worker.
- Procedural Playbook supersede is one SQLite transaction covering successor
  insertion, predecessor CAS, and event persistence. Failure rolls back all
  three durable states; exact replay is idempotent.
- LLM failure diagnostics expose only explicit transport/provider allowlists.
  Secret-shaped or merely syntax-safe provider codes are omitted.
- LanceDB whole-table operations use bounded pages with an explicit 100,000-row
  ceiling. Operations that require a complete view fail closed if that ceiling
  is exceeded; count-only paths use `countRows`.
- The Agent tool surface has an independent
  `allowAgentMemoryWriteTools` containment gate. Setting it to `false` removes
  `memory_store`, `memory_update`, `memory_forget`, and secret-index writes
  while preserving `memory_recall`.
- Cross-process memory-write serialization now has a two-process regression
  that also verifies the private lock-file mode.
- Fixture-only Tailscale addresses were replaced with RFC 5737 documentation
  addresses.

## Verification

- `npm run typecheck`: pass.
- `npm run build`: pass.
- Focused audit regressions: 50/50 pass.
- Full test suite: 624 tests; 622 pass, 0 fail, 2 platform-conditioned skips.
- Deterministic commercial recall benchmark: 124/124 expected hits,
  `knownAnswerRecall=1`, `mrr=1`, no forbidden or cross-scope violations.
- Packed runtime smoke: pass against the locally installed OpenClaw 2026.7.2
  optional peer.

The verification host runs Node 24.14.0, while the candidate declares
`>=24.15.0 <25`. These results therefore do not replace the required release
gate on a conforming Node runtime.

## Still blocked

- Live containment remains separate: stop the two active bypass writers,
  rotate potentially exposed credentials, create three fresh encrypted
  snapshots, regenerate an exact post-stop remediation plan, clean the
  persisted secret/scope debt, and tighten companion permissions.
- The canonical `clawlore` remote and exact published commit are still absent.
- SSRF policy for configurable provider endpoints and CAS semantics for LLM
  read-modify-write merges require separate compatibility design and tests.
- The live-provider 40-positive/10-negative receipt was verified previously,
  but the provider was not rerun in this remediation.
- No deployment, Gateway reload, readiness/approval renewal, or Telegram live
  acceptance was performed.
