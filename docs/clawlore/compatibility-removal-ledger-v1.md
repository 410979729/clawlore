# ClawLore v1 compatibility removal ledger

Status: canonical product identity is ClawLore. Every legacy surface below is
intentional compatibility, not a second product or an internal ClawLore module.

Removal requires all listed evidence, an accepted independent audit, and a
separately planned major-version migration. Silence in telemetry or source
search alone is not authorization to remove a wire/data contract.

| Compatibility surface | Current owner | Why retained | Removal condition |
|---|---|---|---|
| Plugin id `scope-recall-openclaw` | `src/product-identity.ts`, manifest | Existing OpenClaw configurations and extension paths. | Config inventory and documented migration show no remaining legacy-id installation; rollback window has expired. |
| CLI aliases `scope-recall`, `memory-pro` | `cli.ts`, manifest | Existing operator scripts and runbooks. | Alias usage inventory is empty for one declared compatibility cycle and replacement guidance is published. |
| Runtime config key `clawloreV2` | `src/runtime-config.ts`, manifest | Staged configurations created before `runtime` became canonical. | All supported configs use `runtime`; conflict-fail regression can be retired in a major release. |
| Legacy data directory `scope-recall-openclaw` | `src/product-identity.ts` | In-place discovery of existing memory data. | Backup-backed migration receipt proves canonical data-path adoption and rollback no longer depends on the old location. |
| Legacy OAuth directory `.scope-recall-openclaw` | `src/product-identity.ts` | Avoids invalidating existing provider credentials during identity migration. | Credentials have been atomically migrated under the OAuth privacy contract and old-path absence is verified without exposing secrets. |
| Stable `scope_recall_*` dynamic-tool ids | manifest and capability modules | External Agent/tool wire contracts; renaming would break callers. | A versioned tool protocol introduces replacements, consumer inventory is complete, and the old ids have a published deprecation period. |
| Historical task/category strings such as `scope_recall_task` | task/Experience policy | Existing persisted records and replay/classification compatibility. | A schema migration rewrites or maps historical values with parity and rollback evidence. |
| Legacy snapshot profile `scope-recall-legacy-v1` | versioned operator modules | Exact on-disk migration/snapshot protocol identifier. | Never removed while that snapshot format is supported; archive reader retirement requires an explicit format sunset. |
| Deprecated `src/v2/application/*` re-exports | shim files | Downstream source imports during architecture convergence. | Repository/downstream import inventory is empty and one compatibility cycle has passed. |
| Deprecated `src/v2/adapters/openclaw/*` re-exports | shim files | Same source-import compatibility for host adapters. | Same as above, with packed OpenClaw smoke on the removal candidate. |
| Deprecated `src/v2/operator/support-bundle.ts` re-export | shim file | Source-import compatibility for the relocated support-bundle contract. | Import inventory is empty and operator support-bundle tests pass without the shim. |

## Names that are not compatibility debt

`MemoryAddressV2`, `ContextPackV1`, versioned release receipts, authority schema
versions, migration ids, and snapshot format versions name real persisted or
wire protocols. They remain versioned even though the product is ClawLore v1.
Renaming them for cosmetic brand consistency would destroy auditability.

## Enforcement

- `tests/clawlore-product-identity.test.mjs` constrains canonical and legacy
  product surfaces.
- `tests/clawlore-source-governance.test.mjs` prevents unexplained legacy-brand
  growth.
- `tests/public-module-contract.test.mjs` requires relocated `src/v2` files to
  remain pure deprecated re-exports and prevents current runtime code from
  importing non-versioned capability implementations through `src/v2`.
- Dual `runtime` / `clawloreV2` input with different values fails closed; the
  compatibility key cannot silently override canonical configuration.
