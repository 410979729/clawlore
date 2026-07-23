import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { inspectOwnerOnlyTree } from "./persisted-store-permissions.js";
import { findSecret } from "./secret-redaction.js";

const MAX_ARTIFACT_FILES = 10_000;
const MAX_ARTIFACT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_LINE_CHARS = 2 * 1024 * 1024;
const MAX_ENCRYPTED_HEADER_BYTES = 1024 * 1024;
const CLAWLORE_ARCHIVE_MAGIC = Buffer.from("CLAWLORE2\n", "ascii");

const SCANNABLE_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".jsonl",
  ".md",
  ".ndjson",
  ".txt",
]);
interface ArtifactInventoryEntry {
  absolutePath: string;
  fileRef: string;
  size: number;
  device?: string;
  inode?: string;
  mtimeNs?: string;
  classification: "scannable" | "opaque" | "unsupported";
  reason?: string;
}

export interface PersistedSecretArtifactAudit {
  kind: "artifact-roots";
  rootRefs: string[];
  ownerOnlyMode: boolean | null;
  secretBearingRows: number;
  secretBearingFields: number;
  uniqueFlaggedPayloads: number;
  sourceStateDigest: string;
  coverage: {
    complete: boolean;
    roots: number;
    discoveredFiles: number;
    scannedFiles: number;
    encryptedFiles: number;
    unsupportedFiles: number;
    scannedBytes: number;
  };
  findings: Array<{
    fileRef: string;
    scannedRows: number;
    secretBearingRows: number;
    secretBearingFields: number;
    patternCounts: Record<string, number>;
  }>;
  unsupported: Array<{
    fileRef: string;
    reason: string;
  }>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function classifyFile(path: string): "scannable" | "opaque" {
  const extension = extname(path.toLowerCase());
  if (SCANNABLE_EXTENSIONS.has(extension)) return "scannable";
  return "opaque";
}

function containedBy(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function inventoryRoot(rootPath: string): Promise<{
  canonicalRoot: string;
  rootRef: string;
  entries: ArtifactInventoryEntry[];
}> {
  const requestedRoot = resolve(rootPath);
  const requestedInfo = await lstat(requestedRoot);
  if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory()) {
    throw new Error("CLAWLORE_PERSISTED_ARTIFACT_ROOT_MUST_BE_REAL_DIRECTORY");
  }
  const canonicalRoot = await realpath(requestedRoot);
  const rootRef = sha256(canonicalRoot);
  const entries: ArtifactInventoryEntry[] = [];

  async function walk(directory: string): Promise<void> {
    const current = await realpath(directory);
    if (!containedBy(canonicalRoot, current) || current !== resolve(directory)) {
      throw new Error("CLAWLORE_PERSISTED_ARTIFACT_DIRECTORY_ESCAPE");
    }
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const fileRef = sha256(`${rootRef}\0${relative(canonicalRoot, absolutePath)}`);
      const childInfo = await lstat(absolutePath);
      if (childInfo.isSymbolicLink()) {
        entries.push({
          absolutePath,
          fileRef,
          size: 0,
          classification: "unsupported",
          reason: "symbolic_link",
        });
        continue;
      }
      if (childInfo.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!childInfo.isFile()) {
        entries.push({
          absolutePath,
          fileRef,
          size: 0,
          classification: "unsupported",
          reason: "unsupported_file_type",
        });
        continue;
      }
      const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat({ bigint: true });
        entries.push({
          absolutePath,
          fileRef,
          size: Number(info.size),
          device: info.dev.toString(),
          inode: info.ino.toString(),
          mtimeNs: info.mtimeNs.toString(),
          classification: classifyFile(absolutePath),
        });
      } finally {
        await handle.close();
      }
    }
  }

  await walk(canonicalRoot);
  return { canonicalRoot, rootRef, entries };
}

async function scanTextArtifact(entry: ArtifactInventoryEntry): Promise<{
  finding: PersistedSecretArtifactAudit["findings"][number] | null;
  scannedBytes: number;
  payloads: string[];
  stateMaterial: string;
}> {
  if (entry.size > MAX_ARTIFACT_FILE_BYTES) {
    throw new Error("CLAWLORE_PERSISTED_ARTIFACT_FILE_SIZE_LIMIT_EXCEEDED");
  }
  const handle = await open(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      entry.device !== before.dev.toString()
      || entry.inode !== before.ino.toString()
      || entry.size !== Number(before.size)
      || entry.mtimeNs !== before.mtimeNs.toString()
    ) {
      throw new Error("CLAWLORE_PERSISTED_ARTIFACT_CHANGED_BEFORE_AUDIT");
    }
    const contentHash = createHash("sha256");
    const input = handle.createReadStream({ autoClose: false });
    input.on("data", (chunk) => contentHash.update(chunk));
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const patternCounts: Record<string, number> = {};
    const payloads: string[] = [];
    let scannedRows = 0;
    let secretBearingRows = 0;
    for await (const line of lines) {
      scannedRows += 1;
      if (line.length > MAX_ARTIFACT_LINE_CHARS) {
        throw new Error("CLAWLORE_PERSISTED_ARTIFACT_LINE_SIZE_LIMIT_EXCEEDED");
      }
      const secret = findSecret(line);
      if (!secret) continue;
      secretBearingRows += 1;
      payloads.push(sha256(line));
      patternCounts[secret.name] = (patternCounts[secret.name] ?? 0) + 1;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("CLAWLORE_PERSISTED_ARTIFACT_CHANGED_DURING_AUDIT");
    }
    return {
      finding: secretBearingRows === 0 ? null : {
        fileRef: entry.fileRef,
        scannedRows,
        secretBearingRows,
        secretBearingFields: secretBearingRows,
        patternCounts,
      },
      scannedBytes: Number(before.size),
      payloads,
      stateMaterial: [
        entry.fileRef,
        before.size.toString(),
        before.mtimeNs.toString(),
        contentHash.digest("hex"),
        sha256(payloads.slice().sort().join("\0")),
      ].join("\0"),
    };
  } finally {
    await handle.close();
  }
}

function isRecognizedEncryptedContainer(prefix: Buffer, size: number): boolean {
  if (prefix.subarray(0, CLAWLORE_ARCHIVE_MAGIC.length).equals(CLAWLORE_ARCHIVE_MAGIC)) {
    const lengthOffset = CLAWLORE_ARCHIVE_MAGIC.length;
    if (prefix.length < lengthOffset + 4) return false;
    const headerLength = prefix.readUInt32BE(lengthOffset);
    const headerStart = lengthOffset + 4;
    const headerEnd = headerStart + headerLength;
    if (
      headerLength <= 0
      || headerLength > MAX_ENCRYPTED_HEADER_BYTES
      || prefix.length < headerEnd
      || size < headerEnd + 17
    ) return false;
    try {
      const header = JSON.parse(prefix.subarray(headerStart, headerEnd).toString("utf8")) as
        Record<string, unknown>;
      return header.schemaVersion === 1
        && header.algorithm === "aes-256-gcm"
        && typeof header.keyId === "string"
        && header.keyId.length > 0
        && typeof header.iv === "string"
        && header.iv.length > 0;
    } catch {
      return false;
    }
  }
  const asciiPrefix = prefix.subarray(0, 64).toString("ascii");
  if (asciiPrefix.startsWith("age-encryption.org/v1\n")) return true;
  if (asciiPrefix.startsWith("-----BEGIN PGP MESSAGE-----")) return true;
  return false;
}

async function fingerprintOpaqueArtifact(entry: ArtifactInventoryEntry): Promise<{
  encrypted: boolean;
  scannedBytes: number;
  stateMaterial: string;
}> {
  if (entry.size > MAX_ARTIFACT_FILE_BYTES) {
    throw new Error("CLAWLORE_PERSISTED_ARTIFACT_FILE_SIZE_LIMIT_EXCEEDED");
  }
  const handle = await open(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      entry.device !== before.dev.toString()
      || entry.inode !== before.ino.toString()
      || entry.size !== Number(before.size)
      || entry.mtimeNs !== before.mtimeNs.toString()
    ) {
      throw new Error("CLAWLORE_PERSISTED_ARTIFACT_CHANGED_BEFORE_AUDIT");
    }
    const hash = createHash("sha256");
    const prefixChunks: Buffer[] = [];
    let prefixBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      if (prefixBytes < MAX_ENCRYPTED_HEADER_BYTES + 64) {
        const prefixPart = bytes.subarray(
          0,
          Math.min(bytes.length, MAX_ENCRYPTED_HEADER_BYTES + 64 - prefixBytes),
        );
        prefixChunks.push(prefixPart);
        prefixBytes += prefixPart.length;
      }
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("CLAWLORE_PERSISTED_ARTIFACT_CHANGED_DURING_AUDIT");
    }
    const digest = hash.digest("hex");
    return {
      encrypted: isRecognizedEncryptedContainer(
        Buffer.concat(prefixChunks, prefixBytes),
        Number(before.size),
      ),
      scannedBytes: Number(before.size),
      stateMaterial: [
        entry.fileRef,
        before.size.toString(),
        before.mtimeNs.toString(),
        digest,
      ].join("\0"),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Audit explicit backup/export/restore roots without following symlinks or
 * returning path names, file contents, identifiers, or secret values.
 * Unsupported files fail coverage closed instead of being silently omitted.
 */
export async function auditPersistedSecretArtifactRoots(
  rootPaths: string[],
): Promise<PersistedSecretArtifactAudit> {
  if (rootPaths.length === 0) {
    throw new Error("CLAWLORE_PERSISTED_ARTIFACT_ROOT_REQUIRED");
  }
  const uniqueRoots = [...new Set(rootPaths.map((path) => resolve(path)))].sort();
  const rawInventories = await Promise.all(uniqueRoots.map(inventoryRoot));
  const inventories = [...new Map(
    rawInventories.map((inventory) => [inventory.canonicalRoot, inventory]),
  ).values()];
  const entries = inventories.flatMap((inventory) => inventory.entries);
  const unsupported: PersistedSecretArtifactAudit["unsupported"] = [];
  const findings: PersistedSecretArtifactAudit["findings"] = [];
  const flaggedPayloads = new Set<string>();
  const stateMaterial = inventories.map((inventory) => `root\0${inventory.rootRef}`);
  let scannedFiles = 0;
  let encryptedFiles = 0;
  let scannedBytes = 0;
  let secretBearingRows = 0;
  let secretBearingFields = 0;

  if (entries.length > MAX_ARTIFACT_FILES) {
    throw new Error("CLAWLORE_PERSISTED_ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED");
  }
  if (entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_ARTIFACT_TOTAL_BYTES) {
    throw new Error("CLAWLORE_PERSISTED_ARTIFACT_TOTAL_SIZE_LIMIT_EXCEEDED");
  }

  for (const entry of entries) {
    if (entry.classification === "unsupported") {
      unsupported.push({
        fileRef: entry.fileRef,
        reason: entry.reason ?? "unsupported_file",
      });
      stateMaterial.push(`${entry.fileRef}\0unsupported\0${entry.reason ?? "unsupported_file"}`);
      continue;
    }
    try {
      if (entry.classification === "opaque") {
        const inspected = await fingerprintOpaqueArtifact(entry);
        scannedBytes += inspected.scannedBytes;
        stateMaterial.push(inspected.stateMaterial);
        if (!inspected.encrypted) {
          unsupported.push({
            fileRef: entry.fileRef,
            reason: "unrecognized_encrypted_container",
          });
        } else {
          encryptedFiles += 1;
        }
        continue;
      }
      const scanned = await scanTextArtifact(entry);
      scannedFiles += 1;
      scannedBytes += scanned.scannedBytes;
      stateMaterial.push(scanned.stateMaterial);
      for (const payload of scanned.payloads) flaggedPayloads.add(payload);
      if (scanned.finding) {
        findings.push(scanned.finding);
        secretBearingRows += scanned.finding.secretBearingRows;
        secretBearingFields += scanned.finding.secretBearingFields;
      }
    } catch (error) {
      unsupported.push({
        fileRef: entry.fileRef,
        reason: error instanceof Error ? error.message : "artifact_scan_failed",
      });
      stateMaterial.push(`${entry.fileRef}\0scan_failed`);
    }
  }

  const finalInventories = [...new Map(
    (await Promise.all(uniqueRoots.map(inventoryRoot)))
      .map((inventory) => [inventory.canonicalRoot, inventory]),
  ).values()];
  const inventoryState = (items: typeof inventories) => items
    .flatMap((inventory) => inventory.entries.map((entry) => [
      inventory.rootRef,
      entry.fileRef,
      entry.size,
      entry.device ?? "",
      entry.inode ?? "",
      entry.mtimeNs ?? "",
      entry.classification,
      entry.reason ?? "",
    ].join("\0")))
    .sort();
  if (
    JSON.stringify(inventoryState(finalInventories))
    !== JSON.stringify(inventoryState(inventories))
  ) {
    throw new Error("CLAWLORE_PERSISTED_ARTIFACT_INVENTORY_CHANGED_DURING_AUDIT");
  }

  const permissions = inventories.map((inventory) =>
    inspectOwnerOnlyTree(inventory.canonicalRoot));
  const ownerOnlyMode = process.platform === "win32"
    ? null
    : permissions.every((entry) => entry.ownerOnly === true);
  findings.sort((left, right) => left.fileRef.localeCompare(right.fileRef));
  unsupported.sort((left, right) => left.fileRef.localeCompare(right.fileRef));
  return {
    kind: "artifact-roots",
    rootRefs: inventories.map((inventory) => inventory.rootRef).sort(),
    ownerOnlyMode,
    secretBearingRows,
    secretBearingFields,
    uniqueFlaggedPayloads: flaggedPayloads.size,
    sourceStateDigest: sha256(stateMaterial.sort().join("\n")),
    coverage: {
      complete: unsupported.length === 0,
      roots: inventories.length,
      discoveredFiles: entries.length,
      scannedFiles,
      encryptedFiles,
      unsupportedFiles: unsupported.length,
      scannedBytes,
    },
    findings,
    unsupported,
  };
}
