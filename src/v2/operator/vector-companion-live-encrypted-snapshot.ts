import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { enforcePrivatePath, ensurePrivateDirectory } from "../../file-privacy.js";
import {
  createEncryptedGenericSnapshotArchiveV2,
  createFileSecretRefKeyProviderV2,
  restoreEncryptedGenericSnapshotArchiveV2,
} from "./encrypted-snapshot-archive.js";

const require = createRequire(import.meta.url);
type DatabaseSync = any;

function openSqlite(path: string, readOnly = false): DatabaseSync {
  const { DatabaseSync: Database } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
  };
  return new Database(path, { readOnly });
}

interface DirectoryTreeManifest {
  treeDigest: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
}

export interface VectorCompanionLiveEncryptedSnapshotReceiptV2 {
  schemaVersion: 1;
  phase: "clawlore-vector-companion-live-encrypted-snapshot";
  createdAt: string;
  status: "pass";
  authorizesWrites: false;
  sourceRef: string;
  archiveRef: string;
  keyRef: string;
  keyId: string;
  algorithm: "aes-256-gcm";
  archiveSha256: string;
  archiveBytes: number;
  sourceStableDuringBackup: true;
  restoreVerified: true;
  restoredPlaintextRemoved: true;
  vector: DirectoryTreeManifest & {
    table: "memories";
    rowCount: number;
    rowIdDigest: string;
  };
  nextGate: "digest_bound_security_remediation";
}

interface DirectoryEntry {
  path: string;
  kind: "directory" | "file";
  content?: Buffer;
  sha256: string;
  bytes: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function opaquePath(path: string): string {
  return sha256(resolve(path));
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function collectDirectoryEntries(root: string): Promise<DirectoryEntry[]> {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error("vector companion table path must be a non-symlink directory");
  }
  const entries: DirectoryEntry[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error("vector companion contains an unsupported or symbolic-link entry");
      }
      const relativePath = portableRelative(root, path);
      if (info.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory", sha256: sha256(""), bytes: 0 });
        await visit(path);
      } else {
        const content = await readFile(path);
        entries.push({
          path: relativePath,
          kind: "file",
          content,
          sha256: sha256(content),
          bytes: content.length,
        });
      }
    }
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function manifestForEntries(entries: DirectoryEntry[]): DirectoryTreeManifest {
  const material = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    sha256: entry.sha256,
    bytes: entry.bytes,
  }));
  return {
    treeDigest: sha256(JSON.stringify(material)),
    fileCount: entries.filter((entry) => entry.kind === "file").length,
    directoryCount: entries.filter((entry) => entry.kind === "directory").length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

async function writeDirectoryContainer(path: string, entries: DirectoryEntry[]): Promise<void> {
  await writeFile(path, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  const db = openSqlite(path);
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE directory_entries(
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('directory','file')),
        content BLOB,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL
      );
      BEGIN IMMEDIATE;`);
    const insert = db.prepare("INSERT INTO directory_entries VALUES(?,?,?,?,?)");
    for (const entry of entries) {
      insert.run(entry.path, entry.kind, entry.content ?? null, entry.sha256, entry.bytes);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
    await chmod(path, 0o600);
  }
}

function safeDestination(root: string, portablePath: string): string {
  if (!portablePath || portablePath.includes("\\") || portablePath.startsWith("/")
    || portablePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("vector companion snapshot contains an unsafe relative path");
  }
  const target = resolve(root, ...portablePath.split("/"));
  const prefix = `${resolve(root)}${sep}`;
  if (!target.startsWith(prefix)) throw new Error("vector companion snapshot path escaped restore root");
  return target;
}

async function extractDirectoryContainer(containerPath: string, destination: string): Promise<DirectoryTreeManifest> {
  if (existsSync(destination)) throw new Error("vector companion restore destination already exists");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  enforcePrivatePath(destination, { kind: "directory" });
  const db = openSqlite(containerPath, true);
  try {
    db.exec("PRAGMA query_only=ON");
    const rows = db.prepare("SELECT path,kind,content,sha256,bytes FROM directory_entries ORDER BY path").all() as
      Array<{ path: string; kind: "directory" | "file"; content: Uint8Array | null; sha256: string; bytes: number }>;
    for (const row of rows.filter((entry) => entry.kind === "directory")) {
      const target = safeDestination(destination, String(row.path));
      await mkdir(target, { recursive: true, mode: 0o700 });
      enforcePrivatePath(target, { kind: "directory" });
    }
    for (const row of rows.filter((entry) => entry.kind === "file")) {
      const target = safeDestination(destination, String(row.path));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      enforcePrivatePath(dirname(target), { kind: "directory" });
      const content = Buffer.from(row.content ?? []);
      if (content.length !== Number(row.bytes) || sha256(content) !== String(row.sha256)) {
        throw new Error("vector companion snapshot entry checksum mismatch");
      }
      await writeFile(target, content, { flag: "wx", mode: 0o600 });
      enforcePrivatePath(target, { kind: "file" });
    }
  } finally {
    db.close();
  }
  return manifestForEntries(await collectDirectoryEntries(destination));
}

async function inspectVectorRows(root: string): Promise<{ rowCount: number; rowIdDigest: string }> {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(root);
  const table = await db.openTable("memories");
  try {
    const ids = (await table.query().select(["id"]).toArray()).map((row) => String(row.id)).sort();
    return { rowCount: ids.length, rowIdDigest: sha256(JSON.stringify(ids)) };
  } finally {
    await table.close?.();
    await db.close?.();
  }
}

export async function createAndVerifyVectorCompanionLiveEncryptedSnapshotV2(input: {
  sourceRoot: string;
  archivePath: string;
  restoreTestRoot: string;
  receiptPath: string;
  keyId: string;
  secretRefPath: string;
  now?: () => Date;
}): Promise<VectorCompanionLiveEncryptedSnapshotReceiptV2> {
  const sourceRoot = resolve(input.sourceRoot);
  const sourceTable = join(sourceRoot, "memories.lance");
  const archivePath = resolve(input.archivePath);
  const restoreTestRoot = resolve(input.restoreTestRoot);
  const receiptPath = resolve(input.receiptPath);
  if ([archivePath, restoreTestRoot, receiptPath].some((path) => path === sourceRoot || path.startsWith(`${sourceRoot}${sep}`))) {
    throw new Error("vector snapshot outputs must be outside the live source root");
  }
  if (existsSync(archivePath) || existsSync(restoreTestRoot) || existsSync(receiptPath)) {
    throw new Error("vector snapshot destination already exists");
  }
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  ensurePrivateDirectory(dirname(archivePath));
  const temporaryRoot = await mkdtemp(join(dirname(archivePath), ".clawlore-vector-snapshot-"));
  enforcePrivatePath(temporaryRoot, { kind: "directory" });
  const containerPath = join(temporaryRoot, "vector-directory.sqlite3");
  const restoredContainerPath = join(temporaryRoot, "restored-directory.sqlite3");
  const restoredTable = join(restoreTestRoot, "memories.lance");
  const keyProvider = createFileSecretRefKeyProviderV2({
    keyId: input.keyId,
    secretRef: { source: "file", path: input.secretRefPath },
  });
  let completed = false;
  try {
    await keyProvider.current();
    const beforeEntries = await collectDirectoryEntries(sourceTable);
    const beforeTree = manifestForEntries(beforeEntries);
    const beforeRows = await inspectVectorRows(sourceRoot);
    await writeDirectoryContainer(containerPath, beforeEntries);
    const afterTree = manifestForEntries(await collectDirectoryEntries(sourceTable));
    const afterRows = await inspectVectorRows(sourceRoot);
    if (JSON.stringify(beforeTree) !== JSON.stringify(afterTree)
      || JSON.stringify(beforeRows) !== JSON.stringify(afterRows)) {
      throw new Error("vector companion changed during encrypted snapshot capture");
    }
    const archive = await createEncryptedGenericSnapshotArchiveV2({
      sourcePath: containerPath,
      archivePath,
      keyProvider,
      now: () => new Date(createdAt),
    });
    await restoreEncryptedGenericSnapshotArchiveV2({
      archivePath,
      destinationPath: restoredContainerPath,
      expected: archive,
      keyProvider,
      now: input.now,
    });
    await mkdir(restoreTestRoot, { mode: 0o700 });
    enforcePrivatePath(restoreTestRoot, { kind: "directory" });
    const restoredTree = await extractDirectoryContainer(restoredContainerPath, restoredTable);
    const restoredRows = await inspectVectorRows(restoreTestRoot);
    if (JSON.stringify(restoredTree) !== JSON.stringify(beforeTree)
      || JSON.stringify(restoredRows) !== JSON.stringify(beforeRows)) {
      throw new Error("vector companion encrypted snapshot restore verification mismatch");
    }
    await rm(restoreTestRoot, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
    if (existsSync(restoreTestRoot) || existsSync(temporaryRoot)) {
      throw new Error("vector companion plaintext restore cleanup failed");
    }
    const receipt: VectorCompanionLiveEncryptedSnapshotReceiptV2 = {
      schemaVersion: 1,
      phase: "clawlore-vector-companion-live-encrypted-snapshot",
      createdAt,
      status: "pass",
      authorizesWrites: false,
      sourceRef: opaquePath(sourceRoot),
      archiveRef: opaquePath(archivePath),
      keyRef: opaquePath(input.secretRefPath),
      keyId: archive.keyId,
      algorithm: archive.algorithm,
      archiveSha256: archive.archiveSha256,
      archiveBytes: archive.bytes,
      sourceStableDuringBackup: true,
      restoreVerified: true,
      restoredPlaintextRemoved: true,
      vector: { table: "memories", ...beforeTree, ...beforeRows },
      nextGate: "digest_bound_security_remediation",
    };
    ensurePrivateDirectory(dirname(receiptPath));
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    enforcePrivatePath(receiptPath, { kind: "file" });
    completed = true;
    return receipt;
  } finally {
    await rm(restoreTestRoot, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
    if (!completed) {
      await Promise.all([rm(archivePath, { force: true }), rm(receiptPath, { force: true })]);
    }
  }
}
