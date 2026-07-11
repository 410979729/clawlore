# ADR-008: Secrets, provider egress, and backup

Status: accepted.

Provider credentials must resolve through OpenClaw SecretRef or an approved
secret resolver. Every remote route declares data classes, redaction, timeout,
retention assumptions, and fallback privacy level. Plaintext JSONL is an
explicit export, not the default backup; production backups are encrypted
SQLite snapshots with manifests and checksums.
