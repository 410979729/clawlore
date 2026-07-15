import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, lstatSync, readFileSync, readdirSync, } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
export const BUILD_PROVENANCE_FILE = "clawlore-build-provenance.json";
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
}
export function canonicalDigest(value) {
    return sha256(JSON.stringify(canonical(value)));
}
export function resolvePluginRoot(moduleUrl) {
    const modulePath = fileURLToPath(moduleUrl);
    const current = dirname(modulePath);
    if (existsSync(join(current, "package.json")))
        return current;
    const parent = dirname(current);
    if (existsSync(join(parent, "package.json")))
        return parent;
    throw new Error(`Unable to resolve ClawLore plugin root from ${modulePath}`);
}
function fileIdentity(root, path) {
    const body = readFileSync(path);
    return {
        path: relative(root, path).split("\\").join("/"),
        bytes: body.byteLength,
        sha256: sha256(body),
    };
}
function collectRuntimeFiles(root, current, output) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === BUILD_PROVENANCE_FILE)
            continue;
        const path = resolve(current, entry.name);
        if (entry.isSymbolicLink())
            throw new Error(`runtime artifact contains symlink: ${relative(root, path)}`);
        if (entry.isDirectory())
            collectRuntimeFiles(root, path, output);
        else if (entry.isFile())
            output.push(fileIdentity(root, path));
        else
            throw new Error(`runtime artifact contains unsupported entry: ${relative(root, path)}`);
    }
}
export function runtimeArtifactDigest(root) {
    const resolvedRoot = resolve(root);
    const files = [];
    for (const name of ["package.json", "openclaw.plugin.json"]) {
        const path = join(resolvedRoot, name);
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error(`runtime artifact requires regular file: ${name}`);
        files.push(fileIdentity(resolvedRoot, path));
    }
    collectRuntimeFiles(resolvedRoot, join(resolvedRoot, "dist"), files);
    files.sort((left, right) => left.path.localeCompare(right.path));
    return sha256(JSON.stringify(files));
}
function readBuildProvenance(root) {
    const path = join(root, "dist", BUILD_PROVENANCE_FILE);
    if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed.schemaVersion !== 1
            || !/^[a-f0-9]{40}$/i.test(parsed.sourceCommit)
            || !/^[a-f0-9]{64}$/i.test(parsed.testLogDigest)
            || !parsed.generatedBy
            || !Number.isFinite(Date.parse(parsed.createdAt))) {
            throw new Error("build_provenance_schema_invalid");
        }
        return parsed;
    }
    // Development-tree fallback only. Immutable deployment artifacts carry the
    // build provenance sidecar in dist/ and do not depend on Git availability.
    try {
        const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return {
            schemaVersion: 1,
            sourceCommit,
            testLogDigest: process.env.CLAWLORE_TEST_LOG_DIGEST || sha256("development-unverified"),
            generatedBy: "development-tree",
            createdAt: new Date(0).toISOString(),
        };
    }
    catch {
        throw new Error("build_provenance_missing");
    }
}
function truthRows(sqlitePath) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
        const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
            .map((row) => row.name));
        const payload = {};
        if (tableNames.has("memory_truth")) {
            payload.memoryTruth = db.prepare("SELECT id,scope,category,importance,timestamp,metadata,hex(sha256(text)) AS text_hash FROM memory_truth ORDER BY id").all();
        }
        let lifecycle = { active: 0, candidate: 0, archived: 0, other: 0 };
        if (tableNames.has("memory_items")) {
            payload.memoryItems = db.prepare("SELECT item_id,current_revision_id,lifecycle,verification,updated_at,hex(sha256(content)) AS content_hash FROM memory_items ORDER BY item_id").all();
            const counts = db.prepare("SELECT lifecycle,COUNT(*) AS count FROM memory_items GROUP BY lifecycle ORDER BY lifecycle").all();
            for (const row of counts) {
                const count = Number(row.count || 0);
                if (row.lifecycle === "active")
                    lifecycle.active = count;
                else if (row.lifecycle === "candidate")
                    lifecycle.candidate = count;
                else if (row.lifecycle === "archived")
                    lifecycle.archived = count;
                else
                    lifecycle.other += count;
            }
        }
        return { digest: canonicalDigest(payload), lifecycle };
    }
    finally {
        db.close();
    }
}
function safeTruthRows(sqlitePath) {
    try {
        return truthRows(sqlitePath);
    }
    catch (error) {
        // Older SQLite builds may omit the sha256 SQL function. Hash canonical raw
        // rows in JavaScript while preserving the same exact-data binding.
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(sqlitePath, { readOnly: true });
        try {
            const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
            const payload = {};
            if (tables.has("memory_truth"))
                payload.memoryTruth = db.prepare("SELECT * FROM memory_truth ORDER BY id").all();
            let lifecycle = { active: 0, candidate: 0, archived: 0, other: 0 };
            if (tables.has("memory_items")) {
                payload.memoryItems = db.prepare("SELECT * FROM memory_items ORDER BY item_id").all();
                const counts = db.prepare("SELECT lifecycle,COUNT(*) AS count FROM memory_items GROUP BY lifecycle ORDER BY lifecycle").all();
                for (const row of counts) {
                    const count = Number(row.count || 0);
                    if (row.lifecycle === "active")
                        lifecycle.active = count;
                    else if (row.lifecycle === "candidate")
                        lifecycle.candidate = count;
                    else if (row.lifecycle === "archived")
                        lifecycle.archived = count;
                    else
                        lifecycle.other += count;
                }
            }
            return { digest: canonicalDigest(payload), lifecycle };
        }
        finally {
            db.close();
        }
    }
}
export function computeRuntimeReleaseBinding(input) {
    const root = resolve(input.pluginRoot);
    const build = readBuildProvenance(root);
    const truth = safeTruthRows(input.sqlitePath);
    return {
        sourceCommit: build.sourceCommit,
        runtimeDigest: runtimeArtifactDigest(root),
        packageDigest: sha256(readFileSync(join(root, "package.json"))),
        lockDigest: sha256(readFileSync(join(root, "package-lock.json"))),
        configDigest: canonicalDigest(input.config),
        truthSnapshotDigest: truth.digest,
        testLogDigest: build.testLogDigest,
        lifecycle: truth.lifecycle,
        build,
    };
}
