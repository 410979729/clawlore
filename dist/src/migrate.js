/**
 * Migration Utilities
 * Migrates data from old memory-lancedb plugin to clawlore
 */
import { homedir } from "node:os";
import { join } from "node:path";
import fs from "node:fs/promises";
import { loadLanceDB } from "./store.js";
import { diagnosticErrorSummary, diagnosticIdentifier } from "./diagnostic-redaction.js";
import { DEFAULT_LANCE_SCAN_MAX_ROWS, scanLanceRows, } from "./lance-row-scan.js";
function normalizeLegacyVector(value) {
    if (Array.isArray(value)) {
        return value.map((n) => Number(n));
    }
    if (value &&
        typeof value === "object" &&
        Symbol.iterator in value) {
        return Array.from(value, (n) => Number(n));
    }
    return [];
}
// ============================================================================
// Default Paths
// ============================================================================
function getDefaultLegacyPaths() {
    const home = homedir();
    return [
        join(home, ".openclaw", "memory", "lancedb"),
        join(home, ".claude", "memory", "lancedb"),
        // Add more legacy paths as needed
    ];
}
// ============================================================================
// Migration Functions
// ============================================================================
export class MemoryMigrator {
    targetStore;
    constructor(targetStore) {
        this.targetStore = targetStore;
    }
    async migrate(options = {}) {
        const result = {
            success: false,
            migratedCount: 0,
            skippedCount: 0,
            errors: [],
            summary: "",
        };
        try {
            // Find source database
            const sourceDbPath = await this.findSourceDatabase(options.sourceDbPath);
            if (!sourceDbPath) {
                result.errors.push("No legacy database found to migrate from");
                result.summary = "Migration failed: No source database found";
                return result;
            }
            console.log(`Migrating from: ${sourceDbPath}`);
            let sourceCount = 0;
            const aggregate = { migrated: 0, skipped: 0, errors: [] };
            await this.scanLegacyData(sourceDbPath, async (legacyEntries) => {
                sourceCount += legacyEntries.length;
                if (options.dryRun)
                    return;
                const page = await this.migrateEntries(legacyEntries, options);
                aggregate.migrated += page.migrated;
                aggregate.skipped += page.skipped;
                aggregate.errors.push(...page.errors);
            });
            if (sourceCount === 0) {
                result.summary = "Migration completed: No data to migrate";
                result.success = true;
                return result;
            }
            console.log(`Found ${sourceCount} entries to migrate`);
            if (options.dryRun) {
                result.summary = `Dry run: Would migrate ${sourceCount} entries`;
                result.success = true;
                return result;
            }
            result.migratedCount = aggregate.migrated;
            result.skippedCount = aggregate.skipped;
            result.errors.push(...aggregate.errors);
            result.success = result.errors.length === 0;
            result.summary = `Migration ${result.success ? 'completed' : 'completed with errors'}: ` +
                `${result.migratedCount} migrated, ${result.skippedCount} skipped`;
        }
        catch (error) {
            result.errors.push(`MIGRATION_FAILED: ${diagnosticErrorSummary(error)}`);
            result.summary = "Migration failed due to unexpected error";
        }
        return result;
    }
    async findSourceDatabase(explicitPath) {
        if (explicitPath) {
            try {
                await fs.access(explicitPath);
                return explicitPath;
            }
            catch {
                return null;
            }
        }
        // Check default legacy paths
        for (const path of getDefaultLegacyPaths()) {
            try {
                await fs.access(path);
                const files = await fs.readdir(path);
                // Check for LanceDB files
                if (files.some(f => f.endsWith('.lance') || f === 'memories.lance')) {
                    return path;
                }
            }
            catch {
                continue;
            }
        }
        return null;
    }
    async scanLegacyData(sourceDbPath, consume, limit) {
        const lancedb = await loadLanceDB();
        const db = await lancedb.connect(sourceDbPath);
        let table = null;
        try {
            const sourceTable = await db.openTable("memories");
            table = sourceTable;
            const version = await sourceTable.version();
            await sourceTable.checkout(version);
            const sourceCount = await sourceTable.countRows();
            if (!limit && sourceCount > DEFAULT_LANCE_SCAN_MAX_ROWS) {
                throw new Error("CLAWLORE_LANCE_SCAN_LIMIT_EXCEEDED:legacy-migration");
            }
            const scan = await scanLanceRows(() => sourceTable.query(), (rows) => consume(rows.map((row) => ({
                id: row.id,
                text: row.text,
                vector: normalizeLegacyVector(row.vector),
                importance: Number(row.importance),
                category: row.category || "other",
                createdAt: Number(row.createdAt),
                scope: row.scope,
            }))), { maxRows: limit ?? DEFAULT_LANCE_SCAN_MAX_ROWS });
            if (!limit && scan.truncated) {
                throw new Error("CLAWLORE_LANCE_SCAN_LIMIT_EXCEEDED:legacy-migration");
            }
            return scan.scannedRows;
        }
        catch (error) {
            if (error instanceof Error
                && error.message.startsWith("CLAWLORE_LANCE_SCAN_LIMIT_EXCEEDED:")) {
                throw error;
            }
            throw new Error(`CLAWLORE_LEGACY_SOURCE_READ_FAILED: ${diagnosticErrorSummary(error)}`, { cause: error });
        }
        finally {
            try {
                await table?.checkoutLatest();
            }
            catch { }
            try {
                table?.close();
            }
            catch { }
            try {
                db.close();
            }
            catch { }
        }
    }
    async migrateEntries(legacyEntries, options) {
        let migrated = 0;
        let skipped = 0;
        const errors = [];
        const defaultScope = options.defaultScope || "global";
        for (const legacy of legacyEntries) {
            try {
                // Check if entry already exists (if skipExisting is enabled)
                if (options.skipExisting) {
                    if (legacy.id && (await this.targetStore.hasId(legacy.id))) {
                        skipped++;
                        continue;
                    }
                    const existing = await this.targetStore.vectorSearch(legacy.vector, 1, 0.9, [legacy.scope || defaultScope]);
                    if (existing.length > 0 && existing[0].score > 0.95) {
                        skipped++;
                        continue;
                    }
                }
                // Convert legacy entry to new format while preserving legacy identity.
                const newEntry = {
                    id: legacy.id,
                    text: legacy.text,
                    vector: legacy.vector,
                    category: legacy.category,
                    scope: legacy.scope || defaultScope,
                    importance: legacy.importance,
                    timestamp: Number.isFinite(legacy.createdAt) ? legacy.createdAt : Date.now(),
                    metadata: JSON.stringify({
                        migratedFrom: "memory-lancedb",
                        originalId: legacy.id,
                        originalCreatedAt: legacy.createdAt,
                    }),
                };
                await this.targetStore.importEntry(newEntry);
                migrated++;
                if (migrated % 100 === 0) {
                    console.log(`Migrated ${migrated} entries...`);
                }
            }
            catch (error) {
                errors.push(`MIGRATION_ENTRY_FAILED(${diagnosticIdentifier(legacy.id)}): ${diagnosticErrorSummary(error)}`);
                skipped++;
            }
        }
        return { migrated, skipped, errors };
    }
    async checkMigrationNeeded(sourceDbPath) {
        const sourcePath = await this.findSourceDatabase(sourceDbPath);
        if (!sourcePath) {
            return {
                needed: false,
                sourceFound: false,
            };
        }
        try {
            let entryCount = 0;
            await this.scanLegacyData(sourcePath, (entries) => {
                entryCount += entries.length;
            }, 1);
            return {
                needed: entryCount > 0,
                sourceFound: true,
                sourceDbPath: sourcePath,
                entryCount: entryCount > 0 ? undefined : 0,
            };
        }
        catch {
            return {
                // An unreadable source is migration debt, never evidence that no
                // migration is needed.
                needed: true,
                sourceFound: true,
                sourceDbPath: sourcePath,
            };
        }
    }
    async verifyMigration(sourceDbPath) {
        const issues = [];
        try {
            const sourcePath = await this.findSourceDatabase(sourceDbPath);
            if (!sourcePath) {
                return {
                    valid: false,
                    sourceCount: 0,
                    targetCount: 0,
                    issues: ["Source database not found"],
                };
            }
            let sourceCount = 0;
            await this.scanLegacyData(sourcePath, (entries) => {
                sourceCount += entries.length;
            });
            const targetStats = await this.targetStore.stats();
            const targetCount = targetStats.totalCount;
            if (targetCount < sourceCount) {
                issues.push(`Target has fewer entries (${targetCount}) than source (${sourceCount})`);
            }
            return {
                valid: issues.length === 0,
                sourceCount,
                targetCount,
                issues,
            };
        }
        catch (error) {
            return {
                valid: false,
                sourceCount: 0,
                targetCount: 0,
                issues: [`MIGRATION_VERIFICATION_FAILED: ${diagnosticErrorSummary(error)}`],
            };
        }
    }
}
export function createMigrator(targetStore) {
    return new MemoryMigrator(targetStore);
}
export async function migrateFromLegacy(targetStore, options = {}) {
    const migrator = createMigrator(targetStore);
    return migrator.migrate(options);
}
export async function checkForLegacyData() {
    const paths = [];
    let totalEntries = 0;
    for (const path of getDefaultLegacyPaths()) {
        try {
            const lancedb = await loadLanceDB();
            const db = await lancedb.connect(path);
            const table = await db.openTable("memories");
            const entryCount = await table.countRows();
            if (entryCount > 0) {
                paths.push(path);
                totalEntries += entryCount;
            }
        }
        catch {
            continue;
        }
    }
    return {
        found: paths.length > 0,
        paths,
        totalEntries,
    };
}
