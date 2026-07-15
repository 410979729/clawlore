# ClawLore v1 Identity Transition

Status: source candidate only; independent audit required before deployment.

## Canonical identity

| Surface | Canonical value |
| --- | --- |
| Product | `ClawLore` |
| npm package | `clawlore` |
| OpenClaw plugin id | `clawlore` |
| Config root | `plugins.entries.clawlore.config` |
| Primary CLI | `openclaw clawlore` |
| Default extension | `extensions/clawlore` |
| Repository | `410979729/clawlore` |

ClawLore remains on the v1 product line. Identifiers such as `clawloreV2`,
Memory Address V2, and schema V3 describe internal data architecture; they do
not make the product ClawLore v2.

## Compatibility retained

- `scope-recall-openclaw` is declared in `legacyPluginIds` so OpenClaw can
  normalize the old plugin identity during migration.
- `openclaw scope-recall` and `openclaw memory-pro` remain CLI aliases.
- Existing explicit `dbPath` values are authoritative. When no canonical path
  exists, ClawLore reuses the old data and OAuth locations instead of creating
  a competing empty store.
- `scope_recall_*` dynamic-tool ids remain stable wire contracts. Renaming them
  in the same release would break automations without improving runtime safety.
- Historical reports retain the names and paths that were true when captured.

## Deployment gate

This source rename does not authorize live deployment. After independent audit:

1. Record the accepted commit and recursive candidate digest.
2. Back up the live extension, OpenClaw config, and SQLite truth store.
3. Stage exactly one `extensions/clawlore` artifact with the accepted digest.
4. Atomically move the plugin config entry and memory slot to `clawlore`, while
   preserving `dbPath`, shadow/compatibility mode, and all no-cutover controls.
5. Restart once and require health, canonical plugin inspect, `clawlore doctor`,
   exact recursive artifact identity, privacy checks, and read-only probes.

Never load legacy and canonical plugin copies simultaneously: both expose the
same memory slot and tool ids, so dual activation risks duplicate hooks and
writes.

## Rollback

If any post-restart gate fails, restore the extension and config backups as one
unit, restart once, and verify the legacy plugin, doctor, health, and read-only
recall. Restore the encrypted SQLite snapshot only when integrity evidence shows
that the truth store changed or became invalid.
