import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { createRequire } from "node:module";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";
import { enforcePrivatePath, verifyPrivatePath } from "./file-privacy.js";
import { SqlTruthStore } from "./sql-truth-store.js";
const require = createRequire(import.meta.url);
function pathKey(path) {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function canonicalTargetPath(path) {
    const absolute = resolve(path);
    if (existsSync(absolute))
        return realpathSync.native(absolute);
    const parent = dirname(absolute);
    if (!existsSync(parent))
        return absolute;
    return join(realpathSync.native(parent), basename(absolute));
}
function canonicalMigrationPaths(params) {
    const sqlitePath = realpathSync.native(resolve(params.sqlitePath));
    const backupPath = canonicalTargetPath(params.backupPath);
    const receiptPath = canonicalTargetPath(params.receiptPath);
    const keys = [sqlitePath, backupPath, receiptPath].map(pathKey);
    if (new Set(keys).size !== keys.length) {
        throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: source, backup, and receipt paths must be distinct");
    }
    const sourceCompanions = [`${sqlitePath}-wal`, `${sqlitePath}-shm`].map(pathKey);
    if (sourceCompanions.includes(pathKey(backupPath)) || sourceCompanions.includes(pathKey(receiptPath))) {
        throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: migration output aliases a SQLite companion path");
    }
    const backupDirectory = dirname(backupPath);
    const receiptDirectory = dirname(receiptPath);
    if (pathKey(backupDirectory) === pathKey(receiptDirectory)) {
        throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: backup and receipt require separate private directories");
    }
    const dangerousDirectories = new Set([
        pathKey(parse(backupDirectory).root),
        pathKey(homedir()),
        pathKey(tmpdir()),
        pathKey(dirname(sqlitePath)),
    ]);
    for (const directory of [backupDirectory, receiptDirectory]) {
        if (dangerousDirectories.has(pathKey(directory))) {
            throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: migration outputs require dedicated private leaf directories");
        }
    }
    return { sqlitePath, backupPath, receiptPath, backupDirectory, receiptDirectory };
}
function inspectPrivateLeafDirectory(directory, allowedEntries = []) {
    if (!existsSync(directory)) {
        return existsSync(dirname(directory)) ? null : "directory_parent_missing";
    }
    try {
        verifyPrivatePath(directory, { kind: "directory" });
    }
    catch {
        return "directory_not_private";
    }
    const allowed = new Set(allowedEntries);
    if (readdirSync(directory).some((entry) => !allowed.has(entry)))
        return "directory_not_dedicated";
    return null;
}
function preparePrivateLeafDirectory(directory) {
    if (existsSync(directory)) {
        verifyPrivatePath(directory, { kind: "directory" });
        return false;
    }
    if (!existsSync(dirname(directory))) {
        throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: private leaf parent does not exist");
    }
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    enforcePrivatePath(directory, { kind: "directory" });
    return true;
}
function fsyncFileAndParent(path) {
    const fd = openSync(path, "r+");
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    if (process.platform !== "win32") {
        const directoryFd = openSync(dirname(path), "r");
        try {
            fsyncSync(directoryFd);
        }
        finally {
            closeSync(directoryFd);
        }
    }
}
function readInternalMigrationEvidence(sqlitePath) {
    const inspection = SqlTruthStore.inspectAuthority(sqlitePath);
    if (inspection.status !== "valid")
        return null;
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
        const row = db.prepare(`
      SELECT m.migration_id, m.source_truth_rows, m.backup_sha256,
             m.source_snapshot_sha256, m.prepared_at, m.backup_durable_at,
             m.completed_at
      FROM clawlore_sql_truth_authority AS a
      JOIN clawlore_sql_truth_migrations AS m ON m.migration_id = a.migration_id
      WHERE a.singleton = 1 AND a.origin = 'legacy-upgrade'
      LIMIT 1
    `).get();
        if (!row?.migration_id ||
            !row.backup_sha256 ||
            !row.source_snapshot_sha256 ||
            !isIsoTimestamp(row.prepared_at) ||
            !isIsoTimestamp(row.backup_durable_at))
            return null;
        return {
            migrationId: row.migration_id,
            sourceTruthRows: Number(row.source_truth_rows),
            backupSha256: row.backup_sha256,
            sourceSnapshotSha256: row.source_snapshot_sha256,
            preparedAt: row.prepared_at,
            backupDurableAt: row.backup_durable_at,
            completedAt: Number(row.completed_at),
        };
    }
    finally {
        db.close();
    }
}
async function sha256File(path) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path))
        hash.update(chunk);
    return hash.digest("hex");
}
function sha256FileSync(path) {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = openSync(path, "r");
    try {
        let bytesRead = 0;
        do {
            bytesRead = readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0)
                hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    }
    finally {
        closeSync(fd);
    }
    return hash.digest("hex");
}
function isIsoTimestamp(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
        return false;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function completedExternalReceiptMatches(paths, internal) {
    try {
        verifyPrivatePath(paths.backupPath, { kind: "file" });
        verifyPrivatePath(paths.receiptPath, { kind: "file" });
        const parsed = JSON.parse(readFileSync(paths.receiptPath, "utf8"));
        if (parsed.version !== 3 ||
            parsed.status !== "completed" ||
            parsed.migrationId !== internal.migrationId ||
            parsed.sourceDatabase !== basename(paths.sqlitePath) ||
            parsed.backupDatabase !== basename(paths.backupPath) ||
            parsed.receiptFile !== basename(paths.receiptPath) ||
            parsed.backupSha256 !== internal.backupSha256 ||
            parsed.sourceSnapshotSha256 !== internal.sourceSnapshotSha256 ||
            parsed.sourceTruthRows !== internal.sourceTruthRows ||
            parsed.lockProtocol !== "sqlite-begin-immediate-snapshot-digest" ||
            parsed.preparedAt !== internal.preparedAt ||
            parsed.backupDurableAt !== internal.backupDurableAt ||
            parsed.completedAt !== new Date(internal.completedAt).toISOString() ||
            JSON.stringify(parsed.postInspection) !== JSON.stringify(SqlTruthStore.inspectAuthority(paths.sqlitePath)) ||
            (parsed.recoveredAt !== undefined && !isIsoTimestamp(parsed.recoveredAt))) {
            return false;
        }
        if (sha256FileSync(paths.backupPath) !== internal.backupSha256)
            return false;
        const backupInspection = SqlTruthStore.inspectAuthority(paths.backupPath);
        return backupInspection.status === "legacy" &&
            backupInspection.truthRows === internal.sourceTruthRows &&
            SqlTruthStore.legacySnapshotDigest(paths.backupPath) === internal.sourceSnapshotSha256;
    }
    catch {
        return false;
    }
}
function writePrivateJsonAtomic(path, value, faultInjector, phase = "receipt") {
    const directory = dirname(path);
    verifyPrivatePath(directory, { kind: "directory" });
    const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let fd = null;
    try {
        fd = openSync(temporary, "wx+", 0o600);
        writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
        enforcePrivatePath(temporary, { kind: "file" });
        faultInjector?.(`${phase}_before_temp_fsync`);
        fsyncSync(fd);
        faultInjector?.(`${phase}_after_temp_fsync`);
        closeSync(fd);
        fd = null;
        faultInjector?.(`${phase}_before_rename`);
        renameSync(temporary, path);
        enforcePrivatePath(path, { kind: "file" });
        if (process.platform !== "win32") {
            const dirFd = openSync(directory, "r");
            try {
                fsyncSync(dirFd);
            }
            finally {
                closeSync(dirFd);
            }
        }
        faultInjector?.(`${phase}_after_rename`);
    }
    finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch { }
        }
        rmSync(temporary, { force: true });
    }
}
export function inspectLegacyAuthorityMigration(params) {
    const fallbackOutput = {
        truthRows: null,
        sourceDatabase: basename(params.sqlitePath),
        backupDatabase: basename(params.backupPath),
        receiptFile: basename(params.receiptPath),
    };
    let paths;
    try {
        paths = canonicalMigrationPaths(params);
    }
    catch (error) {
        return {
            status: "blocked",
            reason: diagnosticErrorSummary(error),
            ...fallbackOutput,
        };
    }
    const inspection = SqlTruthStore.inspectAuthority(paths.sqlitePath);
    const output = { ...fallbackOutput, truthRows: inspection.truthRows };
    const backupDirectoryIssue = inspectPrivateLeafDirectory(paths.backupDirectory, existsSync(paths.backupPath) ? [basename(paths.backupPath)] : []);
    const receiptDirectoryIssue = inspectPrivateLeafDirectory(paths.receiptDirectory, existsSync(paths.receiptPath) ? [basename(paths.receiptPath)] : []);
    if (backupDirectoryIssue) {
        return { status: "blocked", reason: `backup_${backupDirectoryIssue}`, ...output };
    }
    if (receiptDirectoryIssue) {
        return { status: "blocked", reason: `receipt_${receiptDirectoryIssue}`, ...output };
    }
    if (inspection.status === "valid") {
        const internal = readInternalMigrationEvidence(paths.sqlitePath);
        if (!internal || !existsSync(paths.backupPath)) {
            return { status: "blocked", reason: "source_authority_valid", ...output };
        }
        if (existsSync(paths.receiptPath) && completedExternalReceiptMatches(paths, internal)) {
            return { status: "blocked", reason: "migration_already_completed", ...output };
        }
        return {
            status: "recoverable",
            reason: existsSync(paths.receiptPath)
                ? "external_receipt_corrupt_recoverable"
                : "internal_migration_committed_external_receipt_recoverable",
            ...output,
            truthRows: internal.sourceTruthRows,
        };
    }
    if (inspection.status !== "legacy") {
        return { status: "blocked", reason: `source_authority_${inspection.status}`, ...output };
    }
    if (existsSync(paths.backupPath)) {
        return { status: "blocked", reason: "backup_already_exists", ...output };
    }
    if (existsSync(paths.receiptPath)) {
        return { status: "blocked", reason: "receipt_already_exists", ...output };
    }
    return { status: "ready", reason: "legacy_authority_verified", ...output };
}
export async function migrateLegacySqlAuthority(params) {
    const paths = canonicalMigrationPaths(params);
    const plan = inspectLegacyAuthorityMigration(params);
    if (plan.status === "recoverable") {
        return recoverLegacySqlAuthorityReceipt(paths, params.faultInjector);
    }
    if (plan.status !== "ready" || plan.truthRows === null) {
        throw new Error(`CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: ${plan.reason}`);
    }
    const createdBackupDirectory = preparePrivateLeafDirectory(paths.backupDirectory);
    const createdReceiptDirectory = preparePrivateLeafDirectory(paths.receiptDirectory);
    try {
        const { DatabaseSync } = require("node:sqlite");
        const source = new DatabaseSync(paths.sqlitePath);
        try {
            const quickCheck = String(source.prepare("PRAGMA quick_check").get()?.quick_check || "");
            if (quickCheck !== "ok") {
                throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: source quick_check failed");
            }
            params.faultInjector?.("backup_before_vacuum");
            source.prepare("VACUUM INTO ?").run(paths.backupPath);
            params.faultInjector?.("backup_after_vacuum");
        }
        finally {
            source.close();
        }
        enforcePrivatePath(paths.backupPath, { kind: "file" });
        params.faultInjector?.("backup_before_fsync");
        fsyncFileAndParent(paths.backupPath);
        params.faultInjector?.("backup_after_fsync");
        const sourceStatus = statSync(paths.sqlitePath);
        const backupStatus = statSync(paths.backupPath);
        if (sourceStatus.dev === backupStatus.dev && sourceStatus.ino === backupStatus.ino) {
            throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: backup aliases source identity");
        }
        const backupInspection = SqlTruthStore.inspectAuthority(paths.backupPath);
        if (backupInspection.status !== "legacy" || backupInspection.truthRows !== plan.truthRows) {
            throw new Error("CLAWLORE_SQL_TRUTH_LEGACY_UPGRADE_REFUSED: backup authority verification failed");
        }
        const sourceSnapshotSha256 = SqlTruthStore.legacySnapshotDigest(paths.backupPath);
        const backupSha256 = await sha256File(paths.backupPath);
        const migrationId = randomUUID();
        const preparedAt = new Date().toISOString();
        const backupDurableAt = new Date().toISOString();
        let receipt = {
            version: 3,
            status: "prepared",
            migrationId,
            sourceDatabase: basename(paths.sqlitePath),
            backupDatabase: basename(paths.backupPath),
            receiptFile: basename(paths.receiptPath),
            backupSha256,
            sourceSnapshotSha256,
            sourceTruthRows: plan.truthRows,
            preparedAt,
            backupDurableAt,
            lockProtocol: "sqlite-begin-immediate-snapshot-digest",
        };
        writePrivateJsonAtomic(paths.receiptPath, receipt, params.faultInjector, "prepared_receipt");
        try {
            const completedAt = Date.now();
            const postInspection = SqlTruthStore.upgradeLegacyAuthority(paths.sqlitePath, {
                migrationId,
                backupSha256,
                sourceSnapshotSha256,
                sourceTruthRows: plan.truthRows,
                preparedAt,
                backupDurableAt,
                completedAt,
            }, params.faultInjector);
            receipt = {
                ...receipt,
                status: "completed",
                completedAt: new Date(completedAt).toISOString(),
                postInspection,
            };
            params.faultInjector?.("external_receipt_before_completed_write");
            writePrivateJsonAtomic(paths.receiptPath, receipt, params.faultInjector, "completed_receipt");
            return receipt;
        }
        catch (error) {
            const internal = readInternalMigrationEvidence(paths.sqlitePath);
            if (internal?.migrationId === migrationId) {
                try {
                    return await recoverLegacySqlAuthorityReceipt(paths, params.faultInjector);
                }
                catch (recoveryError) {
                    throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_RECEIPT_RECOVERY_REQUIRED: database migration committed but external receipt needs reconciliation", { cause: recoveryError });
                }
            }
            receipt = {
                ...receipt,
                status: "failed",
                failureCode: diagnosticErrorSummary(error),
            };
            try {
                writePrivateJsonAtomic(paths.receiptPath, receipt);
            }
            catch { }
            throw error;
        }
    }
    finally {
        if (!existsSync(paths.receiptPath) &&
            existsSync(paths.backupPath) &&
            SqlTruthStore.inspectAuthority(paths.sqlitePath).status === "legacy") {
            rmSync(paths.backupPath, { force: true });
        }
        for (const [directory, created] of [
            [paths.backupDirectory, createdBackupDirectory],
            [paths.receiptDirectory, createdReceiptDirectory],
        ]) {
            if (!created || !existsSync(directory))
                continue;
            try {
                if (readdirSync(directory).length === 0)
                    rmSync(directory, { recursive: true, force: false });
            }
            catch { }
        }
    }
}
async function recoverLegacySqlAuthorityReceipt(paths, faultInjector) {
    const internal = readInternalMigrationEvidence(paths.sqlitePath);
    if (!internal) {
        throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_RECEIPT_RECOVERY_REFUSED: internal migration evidence missing");
    }
    verifyPrivatePath(paths.backupDirectory, { kind: "directory" });
    verifyPrivatePath(paths.receiptDirectory, { kind: "directory" });
    verifyPrivatePath(paths.backupPath, { kind: "file" });
    const backupSha256 = await sha256File(paths.backupPath);
    if (backupSha256 !== internal.backupSha256) {
        throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_RECEIPT_RECOVERY_REFUSED: backup digest mismatch");
    }
    const backupInspection = SqlTruthStore.inspectAuthority(paths.backupPath);
    const sourceSnapshotSha256 = SqlTruthStore.legacySnapshotDigest(paths.backupPath);
    if (backupInspection.status !== "legacy" ||
        backupInspection.truthRows !== internal.sourceTruthRows ||
        sourceSnapshotSha256 !== internal.sourceSnapshotSha256) {
        throw new Error("CLAWLORE_SQL_TRUTH_MIGRATION_RECEIPT_RECOVERY_REFUSED: backup snapshot mismatch");
    }
    const receipt = {
        version: 3,
        status: "completed",
        migrationId: internal.migrationId,
        sourceDatabase: basename(paths.sqlitePath),
        backupDatabase: basename(paths.backupPath),
        receiptFile: basename(paths.receiptPath),
        backupSha256: internal.backupSha256,
        sourceSnapshotSha256: internal.sourceSnapshotSha256,
        sourceTruthRows: internal.sourceTruthRows,
        preparedAt: internal.preparedAt,
        backupDurableAt: internal.backupDurableAt,
        lockProtocol: "sqlite-begin-immediate-snapshot-digest",
        completedAt: new Date(internal.completedAt).toISOString(),
        recoveredAt: new Date().toISOString(),
        postInspection: SqlTruthStore.inspectAuthority(paths.sqlitePath),
    };
    writePrivateJsonAtomic(paths.receiptPath, receipt, faultInjector, "recovered_receipt");
    return receipt;
}
