# ADR-005: One Context Composer

Status: accepted.

All automatic memory, reflection, conflict, freshness, and playbook injection
must be selected under one token budget and emitted as one traceable Context
Pack. Existing hooks become compatibility adapters rather than independent
prompt writers.
