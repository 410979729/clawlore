import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
const TRUTH_TABLES = [
    "memory_item_identities",
    "memory_items",
    "memory_revisions",
    "memory_sources",
    "memory_acl",
    "memory_relations",
    "memory_events",
    "projection_outbox",
];
async function sha256File(path) {
    const hash = createHash("sha256");
    await new Promise((resolve, reject) => {
        const stream = createReadStream(path);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", resolve);
    });
    return hash.digest("hex");
}
function openReadOnly(path) {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(path, { readOnly: true });
}
export async function inspectSqliteSnapshotV2(path, createdAt = new Date().toISOString()) {
    const db = openReadOnly(path);
    try {
        const integrityRow = db.prepare("PRAGMA integrity_check").get();
        const integrity = String(integrityRow.integrity_check ?? Object.values(integrityRow)[0] ?? "");
        if (integrity !== "ok")
            throw new Error(`snapshot integrity check failed: ${integrity}`);
        const foreignKeyViolations = Number(db.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get().count);
        if (foreignKeyViolations !== 0)
            throw new Error(`snapshot foreign key check failed: ${foreignKeyViolations}`);
        const schema = db.prepare("SELECT MAX(version) AS version FROM clawlore_schema").get();
        const truthSchemaVersion = Number(schema.version);
        if (!Number.isInteger(truthSchemaVersion) || truthSchemaVersion < 2) {
            throw new Error("snapshot does not contain a supported ClawLore Truth V2 schema");
        }
        const tableCounts = Object.fromEntries(TRUTH_TABLES.map((table) => [
            table,
            Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
        ]));
        const info = await stat(path);
        return {
            schemaVersion: 1,
            createdAt,
            sha256: await sha256File(path),
            bytes: info.size,
            truthSchemaVersion,
            integrity: "ok",
            foreignKeyViolations,
            tableCounts,
        };
    }
    finally {
        db.close();
    }
}
export async function createOnlineSqliteBackupV2(sourcePath, destinationPath) {
    if (existsSync(destinationPath))
        throw new Error("backup destination already exists");
    mkdirSync(dirname(destinationPath), { recursive: true });
    const { backup } = require("node:sqlite");
    const source = openReadOnly(sourcePath);
    try {
        await backup(source, destinationPath, { rate: 128 });
    }
    catch (error) {
        await rm(destinationPath, { force: true });
        throw error;
    }
    finally {
        source.close();
    }
}
export async function createVerifiedSqliteSnapshotV2(input) {
    const createdAt = (input.now?.() ?? new Date()).toISOString();
    await createOnlineSqliteBackupV2(input.sourcePath, input.destinationPath);
    try {
        return await inspectSqliteSnapshotV2(input.destinationPath, createdAt);
    }
    catch (error) {
        await rm(input.destinationPath, { force: true });
        throw error;
    }
}
export async function restoreVerifiedSqliteSnapshotV2(input) {
    const source = await inspectSqliteSnapshotV2(input.snapshotPath, input.expected.createdAt);
    if (source.sha256 !== input.expected.sha256)
        throw new Error("snapshot checksum mismatch");
    if (source.truthSchemaVersion !== input.expected.truthSchemaVersion)
        throw new Error("snapshot schema mismatch");
    if (JSON.stringify(source.tableCounts) !== JSON.stringify(input.expected.tableCounts)) {
        throw new Error("snapshot table-count manifest mismatch");
    }
    await createOnlineSqliteBackupV2(input.snapshotPath, input.destinationPath);
    try {
        const restored = await inspectSqliteSnapshotV2(input.destinationPath, (input.now?.() ?? new Date()).toISOString());
        if (restored.truthSchemaVersion !== source.truthSchemaVersion
            || JSON.stringify(restored.tableCounts) !== JSON.stringify(source.tableCounts)) {
            throw new Error("restored database verification mismatch");
        }
        return restored;
    }
    catch (error) {
        await rm(input.destinationPath, { force: true });
        throw error;
    }
}
