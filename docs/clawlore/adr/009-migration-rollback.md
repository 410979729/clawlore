# ADR-009: Additive migration and rollback

Status: accepted.

No big-bang rewrite. Preview legacy mapping, add v2 tables, shadow compare,
switch writes, rebuild projections, then cut over with approval. Preserve
unknown rows as debt. Rollback restores a verified snapshot and configuration
pointer; it does not reverse-mutate a partially migrated live database.

The final authority model is not permanent dual-write. V1 remains the rollback
lane through shadow and V2-write transition; V2 becomes authoritative at
cutover. V1 leaves the normal runtime only after the stricter retirement gate
proves complete mapping, ownership, lifecycle, content, projection, and outbox
convergence.
