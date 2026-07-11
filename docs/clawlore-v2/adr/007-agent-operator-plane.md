# ADR-007: Agent and Operator plane separation

Status: accepted with a product-specific exception.

Remember/query/correct/forget/feedback form the Agent memory facade. Repair,
reindex, compact, migration, backup, governance, dashboard, replay management,
and candidate promotion move to CLI/UI. Experience query/preflight may stay in
the Agent facade when it is scope-safe and matches available tools.
