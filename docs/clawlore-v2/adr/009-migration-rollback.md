# ADR-009: Additive migration and rollback

Status: accepted.

No big-bang rewrite. Preview legacy mapping, add v2 tables, shadow compare,
switch writes, rebuild projections, then cut over with approval. Preserve
unknown rows as debt. Rollback restores a verified snapshot and configuration
pointer; it does not reverse-mutate a partially migrated live database.
