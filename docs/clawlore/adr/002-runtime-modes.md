# ADR-002: Compatibility hooks before ContextEngine

Status: accepted and completed for the 1.2.3 source candidate.

Build one compatibility Context Composer first. Add an opt-in ContextEngine
adapter only after capability negotiation and lifecycle tests. Do not select
the ContextEngine slot during Phase 0 or let a memory plugin accidentally take
ownership of transcript compaction.

The native adapter is now present but remains cutover-receipt gated. It
registers the canonical `clawlore` engine id, does not ingest transcripts, and
returns host-owned compaction unchanged. Shadow and V2-write transition retain
the compatibility engine.
