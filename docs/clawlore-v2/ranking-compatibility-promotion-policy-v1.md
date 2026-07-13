# Ranking compatibility and candidate promotion policy V1

Status: fixture-validated design only. This document does not authorize a live
schema change, reindex, candidate promotion, prompt mutation, ContextEngine, or
final-recall cutover.

## Problem split

The live Phase 7E gate found two independent cutover blockers:

1. V1 FTS indexes `text + metadata_text`, while the additive V2 projection
   indexes `content + category`. The canonical content is equivalent, but the
   different auxiliary fields can change discovery and ranking.
2. All non-archived V2 rows are candidates. Identity, provenance, verification,
   and scope evidence are not uniform, so lifecycle promotion cannot be a bulk
   migration rule.

These blockers must stay separate. Ranking compatibility cannot make an
unverified candidate injectable, and promotion evidence cannot repair an
incompatible index.

## Rebuildable compatibility projection

The fixture design uses a separate `memory_fts_compat_v2` projection with the
same searchable field shape as V1:

```sql
CREATE VIRTUAL TABLE memory_fts_compat_v2 USING fts5(
  item_id UNINDEXED,
  content,
  metadata_text
);
```

The projection is not canonical truth. `memory_items` remains authoritative.
For the compatibility window, a digest-bound one-time backfill may read the
already-derived V1 `memory_truth.metadata_text`; it must not copy the raw
legacy metadata JSON. Only the historical search allowlist is admissible:

- `l0_abstract`
- `l1_overview`
- `l2_content`
- `keywords`
- `entities`
- `tags`
- `category`
- `tier`

Sender ids, session ids, addresses, credentials, receipts, and arbitrary
metadata keys are excluded. A future live backfill must pass capture-safety and
redaction checks, write only the rebuildable projection, record convergence,
and keep the current V2 FTS table intact until rollback evidence is complete.

The synthetic fixture intentionally produces minimum current-V2 overlap below
0.8. The compatibility projection restores minimum overlap and rank agreement
to 1.0 without emitting query text, content, raw ids, or metadata values.

## Evidence-backed promotion policy

The policy is read-only and returns hashed item ids plus reason codes. It never
changes lifecycle and always reports `automaticPromotionRows=0` and
`authorizesLiveMutation=false`.

| Candidate lane | Minimum evidence | Disposition |
| --- | --- | --- |
| Manual/private | trusted runtime or registry-direct attribution, matching principal, evidence digest, user/operator confirmation | eligible for bounded promotion |
| Manual/conversation | registry-conversation attribution, matching conversation boundary and digest, user/operator confirmation | eligible for bounded promotion |
| Task experience | trusted identity/boundary, tool/operator verification, at least one source receipt | eligible for bounded promotion |
| Reflection/checkpoint/auto-capture | trusted identity/boundary, explicit operator review id, operator verification, at least one receipt | eligible for bounded promotion |
| Missing identity or derived-system-only | insufficient evidence | hold candidate |
| Opaque source, legacy agent alias, unknown legacy, disputed verification | unverifiable or unsafe | quarantine |
| Archived/superseded/purged | non-active lifecycle | preserve archived |

Even an eligible row may be changed only by an executor bound to the exact
item-digest list and rollback receipt. Eligibility is not mutation authority.

## Required live gates

Before any live change, require all of the following in a later rollout:

1. a fresh encrypted snapshot and restore verification;
2. a read-only live ranking/backfill preview with no memory/query content in its receipt;
3. a collision-safe additive projection apply and rollback plan;
4. exact projection convergence and native overlap/rank agreement at least 0.8;
5. a read-only promotion plan over the live candidates with address-bound evidence;
6. an exact projection and/or promotion digest enforced by the executor;
7. post-apply SQL/FTS/vector/relation, policy, Gateway, and real-channel smoke.

ContextEngine, prompt mutation, and final recall remain separate later gates.
