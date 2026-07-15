# ADR-002: Compatibility hooks before ContextEngine

Status: accepted.

Build one compatibility Context Composer first. Add an opt-in ContextEngine
adapter only after capability negotiation and lifecycle tests. Do not select
the ContextEngine slot during Phase 0 or let a memory plugin accidentally take
ownership of transcript compaction.
