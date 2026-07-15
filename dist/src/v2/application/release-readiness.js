import { CLAWLORE_CLI_ALIASES, CLAWLORE_CLI_PRIMARY, CLAWLORE_CONFIG_ROOT, CLAWLORE_LEGACY_PLUGIN_IDS, CLAWLORE_PACKAGE_NAME, CLAWLORE_PLUGIN_ID, CLAWLORE_PRODUCT_NAME, } from "../../product-identity.js";
export const CLAWLORE_COMPATIBILITY_SURFACE_V1 = {
    productBrand: CLAWLORE_PRODUCT_NAME,
    packageName: CLAWLORE_PACKAGE_NAME,
    manifestId: CLAWLORE_PLUGIN_ID,
    configRoot: CLAWLORE_CONFIG_ROOT,
    cliPrimary: CLAWLORE_CLI_PRIMARY,
    cliAliases: [...CLAWLORE_CLI_ALIASES],
    legacyPluginIds: [...CLAWLORE_LEGACY_PLUGIN_IDS],
    legacyConfigRoots: ["plugins.entries.scope-recall-openclaw.config"],
    dataDirectoryPolicy: "preserve_existing",
    sourceMetadataPolicy: "preserve_historical",
    compatibilityMajorVersions: 1,
};
export function validateCompatibilitySurface(input) {
    const failures = [];
    if (input.packageName !== CLAWLORE_COMPATIBILITY_SURFACE_V1.packageName)
        failures.push("package_name_changed");
    if (input.manifestId !== CLAWLORE_COMPATIBILITY_SURFACE_V1.manifestId)
        failures.push("manifest_id_changed");
    for (const legacyId of CLAWLORE_COMPATIBILITY_SURFACE_V1.legacyPluginIds) {
        if (!input.manifestLegacyPluginIds.includes(legacyId))
            failures.push(`legacy_plugin_id_missing:${legacyId}`);
    }
    for (const command of [CLAWLORE_COMPATIBILITY_SURFACE_V1.cliPrimary, ...CLAWLORE_COMPATIBILITY_SURFACE_V1.cliAliases]) {
        if (!input.manifestCommands.includes(command))
            failures.push(`manifest_command_missing:${command}`);
    }
    return failures;
}
function evidenceFailures(mode, evidence) {
    if (mode === "disabled")
        return [];
    const failures = [];
    for (const name of ["focusedTests", "fullTests", "typecheck", "build", "moduleBoundaries", "releaseGate"]) {
        if (!evidence[name])
            failures.push(`gate_failed:${name}`);
    }
    if (evidence.forbiddenScopeViolations !== 0)
        failures.push("forbidden_scope_violation");
    if (mode === "v2-write" || mode === "cutover") {
        for (const name of ["snapshotVerified", "migrationDrill", "rollbackDrill", "legacyHashUnchanged"]) {
            if (!evidence[name])
                failures.push(`gate_failed:${name}`);
        }
    }
    return failures;
}
function rolloutSteps(mode) {
    const steps = [
        { order: 1, action: "record_live_inventory_and_config_hash", mutatesLive: false, rollback: "none" },
        { order: 2, action: "create_verified_encrypted_snapshot", mutatesLive: false, rollback: "delete_unselected_archive" },
    ];
    if (mode === "shadow") {
        steps.push({ order: 3, action: "enable_redacted_read_only_shadow", mutatesLive: true, rollback: "restore_config_pointer" });
    }
    else if (mode === "v2-write") {
        steps.push({ order: 3, action: "apply_additive_v2_schema", mutatesLive: true, rollback: "restore_snapshot_to_new_location" }, { order: 4, action: "enable_v2_single_write_with_v1_fallback_read", mutatesLive: true, rollback: "restore_config_pointer" });
    }
    else if (mode === "cutover") {
        steps.push({ order: 3, action: "apply_additive_v2_schema", mutatesLive: true, rollback: "restore_snapshot_to_new_location" }, { order: 4, action: "rebuild_and_verify_all_projections", mutatesLive: true, rollback: "discard_rebuildable_projections" }, { order: 5, action: "atomic_cutover_after_quality_gates", mutatesLive: true, rollback: "restore_config_and_database_pointer" });
    }
    return steps;
}
export function previewRollout(input) {
    const blockingReasons = [
        ...(input.compatibilityFailures ?? []),
        ...evidenceFailures(input.requestedMode, input.evidence),
    ].sort();
    return {
        schemaVersion: 1,
        rolloutId: input.rolloutId,
        requestedMode: input.requestedMode,
        currentMode: input.currentMode,
        ready: blockingReasons.length === 0,
        readOnly: input.requestedMode === "disabled" || input.requestedMode === "shadow",
        blockingReasons,
        steps: rolloutSteps(input.requestedMode),
        compatibility: CLAWLORE_COMPATIBILITY_SURFACE_V1,
        createdAt: (input.now?.() ?? new Date()).toISOString(),
    };
}
export function buildReleaseReadinessReceipt(input) {
    const rollout = previewRollout(input);
    return {
        schemaVersion: 1,
        status: rollout.ready ? "ready" : "blocked",
        compatibilityValid: (input.compatibilityFailures ?? []).length === 0,
        rollout,
        responseSchemas: ["memory-action.v2", "memory-center.v1", "projection-convergence.v1", "replay-evaluation.v2"],
    };
}
