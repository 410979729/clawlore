# Security Policy

## Supported Versions

The active beta line is `2.0.x`. Security fixes should target the latest beta unless a maintainer explicitly opens a backport branch.

## Reporting A Vulnerability

Please report vulnerabilities through GitHub issues only when the report does not contain secrets, live credentials, private logs, or exploitable payloads. For sensitive reports, contact the maintainer privately and provide a redacted reproduction first.

Do not paste API keys, bearer tokens, OpenClaw gateway tokens, database passwords, private logs, or complete `.env` files into public issues.

## Secret Handling Expectations

ClawLore must not persist credential-like content as memory. Capture safety blocks common token, bearer, password, and credentialed URL patterns before storage. If you find a secret pattern that is not blocked, treat it as a security bug.

The secret-index surface accepts vault references and an optional locally
generated SHA-256 fingerprint only. It never accepts plaintext through tool
arguments because host transcripts and provider logs are outside the plugin's
database boundary.

Private memory is scoped to the authenticated principal. Group/channel memory
is denied by default, and host group policies should also deny memory tools.
Mention requirements are not authorization. Do not enable shared global or
legacy agent-scope reads for untrusted principals.

Release readiness receipts are not self-attestation booleans. They must be
private `0600` files bound to an exact commit, runtime artifact, config, data
snapshot, and test log, with a finite expiry. Shadow always requires a current
exact receipt. A successful V2-write/cutover activation records a durable
release authority in the same private SQLite truth database; it permits only
subsequent truth-snapshot drift and receipt expiry while the receipt body,
commit, runtime/package/lock artifacts, config, and test evidence remain
unchanged. Missing, malformed, or rewritten receipt/authority data and every
immutable mismatch must block registration until a fresh exact receipt passes.

Public defaults keep automatic capture, LLM extraction, and plaintext JSONL backups disabled. Enabling hosted extraction, embeddings, reranking, OAuth, reflection storage, rejected-candidate audits, or backups can persist or transmit conversation-derived data; do that only with an explicit operator decision.

Release packages must not contain:

- `.env` files
- SQLite databases
- LanceDB vector stores
- logs
- `node_modules/`
- backups or temporary state

Run this before publishing:

```bash
npm test
npm run release:gate
npm pack --dry-run --json
```
