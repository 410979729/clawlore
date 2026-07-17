# ClawLore v1 live identity rollout preflight — 2026-07-17

## Decision

**NO-GO before live mutation.** Joy authorized loading the canonical ClawLore
candidate in an authenticated Telegram direct conversation. The candidate and
Linux rollout mechanics passed fresh preflight, but the mandatory real-Windows
Node 24 gate and independent source review remain open. The Windows client was
offline during this run, so no live extension, configuration, database, or
Gateway state was changed.

Candidate: `c6bfb29841b727e324a2d986f34f878adfb882d2`
(`clawlore@1.2.0`, OpenClaw plugin id `clawlore`).

## Fresh candidate evidence

- `npm ci --ignore-scripts --include=dev` completed with zero reported
  vulnerabilities.
- The clean-source Linux release gate passed 418 total tests: 416 passed,
  0 failed, and 2 Windows-only skips. Typecheck, build, vector repair,
  124/124 deterministic recall, the 200,000-row FTS baseline, all three packed
  smokes, the 42-component SBOM, the 239-file package scan, and the official
  registry vulnerability audit all passed.
- Reproducibility verification passed with release-input digest
  `6f7edcc2692f8e718b3e0bda6682975a408641ea4354f8ce528af79cef908e27`,
  runtime digest
  `40d827230c0d2e7c48fbe364228eaf69739a75862acb983bfb24a8c3e3cbeb69`,
  and lock digest
  `66e22abef648c898e8e4e41c3e9e5edb399437b70a7a697cd8f3206ff731b7cd`.

## Live baseline and migration canary

- The Gateway remained healthy on `scope-recall-openclaw@1.1.0`; no canonical
  ClawLore copy was loaded.
- The live SQLite truth store contained 1,036 truth rows and correctly
  reported `legacy_authority_requires_marker_upgrade` to the strict candidate.
- A private SQLite-consistent copy of the live database was migrated with the
  candidate's explicit authority migration. It reached schema version 4 with
  1,036 truth rows, 1,036 FTS rows, `quick_check` success, zero foreign-key
  violations, and a successful strict-store reopen.
- The migration canary directory was removed. The live database was not
  touched.

## Configuration and package staging preview

An isolated state root proved the required atomic ordering:

1. stage exactly one packed `extensions/clawlore` artifact with runtime
   dependencies;
2. move the complete canonical entry, allowlist, memory slot, and `runtime`
   configuration together;
3. never load the legacy and canonical plugin copies at the same time.

The preview loaded `clawlore@1.2.0`; canonical `clawlore`, plus compatibility
aliases `scope-recall` and `memory-pro`, all reported version `1.2.0`. The
preview root was removed.

## Blocking evidence

- OpenClaw reported no connected nodes.
- The registered Windows work computer was offline in the tailnet.
- One bounded, non-mutating SSH reachability probe timed out. It was not
  retried, woken, or modified.
- Therefore the exact Windows Node 24 gate and cleanup of the owned Windows
  audit directory could not run. Independent source review also remains open.

## Required continuation

Bring the authorized Windows work computer online, then run the exact Windows
Node 24 gate and clean only the owned audit directory. If that and the
independent review pass on this exact candidate, perform the backup-backed,
single-restart canonical identity rollout and real live recall/privacy
verification. Until then the supported decision remains NO-GO.
