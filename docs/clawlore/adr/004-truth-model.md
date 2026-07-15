# ADR-004: Revision/event/outbox SQL truth

Status: accepted for Phase 2 design.

Use immutable revisions, explicit sources and ACL, append-only events, current
materialized items, and a transactional projection outbox. FTS/vector/relation
failures may degrade retrieval but cannot corrupt or replace SQL truth.
