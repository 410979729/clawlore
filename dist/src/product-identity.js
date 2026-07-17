export const CLAWLORE_PRODUCT_NAME = "ClawLore";
export const CLAWLORE_PLUGIN_ID = "clawlore";
export const CLAWLORE_PACKAGE_NAME = "clawlore";
export const CLAWLORE_CONFIG_ROOT = "plugins.entries.clawlore.config";
export const CLAWLORE_RUNTIME_CONFIG_KEY = "runtime";
export const CLAWLORE_CLI_PRIMARY = "clawlore";
export const CLAWLORE_CLI_ALIASES = ["scope-recall", "memory-pro"];
export const CLAWLORE_LEGACY_PLUGIN_IDS = ["scope-recall-openclaw"];
export const CLAWLORE_LEGACY_CONFIG_ROOTS = [
    `plugins.entries.${CLAWLORE_LEGACY_PLUGIN_IDS[0]}.config`,
];
export const CLAWLORE_LEGACY_RUNTIME_CONFIG_KEYS = ["clawloreV2"];
export const CLAWLORE_DESCRIPTION = "ClawLore memory for OpenClaw: SQLite truth, scoped hybrid recall, conservative capture, and rebuildable vectors";
export const CLAWLORE_LEGACY_DEFAULTS = {
    dataDirectoryName: "scope-recall-openclaw",
    oauthDirectoryName: ".scope-recall-openclaw",
};
