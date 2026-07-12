import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createVerifiedSqliteSnapshotV2,
  inspectSqliteSnapshotV2,
  restoreVerifiedSqliteSnapshotV2,
  type SqliteSnapshotManifestV2,
} from "./sqlite-snapshot.js";
import {
  createVerifiedLegacySqliteSnapshotV2,
  inspectLegacySqliteSnapshotV2,
  restoreVerifiedLegacySqliteSnapshotV2,
  type LegacySqliteSnapshotManifestV2,
} from "./legacy-v1-snapshot.js";

const MAGIC = Buffer.from("CLAWLORE2\n", "ascii");
const HEADER_LENGTH_BYTES = 4;
const AUTH_TAG_BYTES = 16;
const MAX_HEADER_BYTES = 1024 * 1024;

export interface SnapshotArchiveKeyV2 {
  keyId: string;
  key: Uint8Array;
}

export interface SnapshotArchiveKeyProviderV2 {
  current(): Promise<SnapshotArchiveKeyV2>;
  resolve(keyId: string): Promise<SnapshotArchiveKeyV2>;
}

export interface FileSecretRefV2 {
  source: "file";
  path: string;
}

export interface EncryptedSnapshotArchiveManifestV2 {
  schemaVersion: 1;
  createdAt: string;
  algorithm: "aes-256-gcm";
  keyId: string;
  archiveSha256: string;
  bytes: number;
  snapshot: SqliteSnapshotManifestV2;
}

export interface EncryptedLegacySnapshotArchiveManifestV2 {
  schemaVersion: 1;
  createdAt: string;
  algorithm: "aes-256-gcm";
  keyId: string;
  archiveSha256: string;
  bytes: number;
  snapshot: LegacySqliteSnapshotManifestV2;
}

interface ArchiveHeaderV2 {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  snapshot: SqliteSnapshotManifestV2 | LegacySqliteSnapshotManifestV2;
}

function normalizeKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.length !== 32) throw new Error("snapshot archive key must be exactly 32 bytes");
  return key;
}

function decodeFileKey(value: Buffer): Buffer {
  if (value.length === 32) return value;
  const text = value.toString("utf8").trim();
  if (/^[A-Fa-f0-9]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(text) || /^[A-Za-z0-9_-]{43}=?$/.test(text)) {
    const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64");
    if (decoded.length === 32) return decoded;
  }
  throw new Error("file SecretRef must contain a raw, hex, or base64 32-byte key");
}

export function createFileSecretRefKeyProviderV2(input: {
  keyId: string;
  secretRef: FileSecretRefV2;
}): SnapshotArchiveKeyProviderV2 {
  if (!input.keyId.trim()) throw new Error("snapshot archive key id is required");
  const load = async (): Promise<SnapshotArchiveKeyV2> => {
    const info = await stat(input.secretRef.path);
    if (!info.isFile()) throw new Error("file SecretRef must resolve to a regular file");
    if ((info.mode & 0o077) !== 0) throw new Error("file SecretRef permissions must be 0600 or stricter");
    return { keyId: input.keyId, key: decodeFileKey(await readFile(input.secretRef.path)) };
  };
  return {
    current: load,
    async resolve(keyId: string) {
      if (keyId !== input.keyId) throw new Error(`snapshot archive key is unavailable: ${keyId}`);
      return load();
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function removeSqliteFiles(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

function encodeHeader(header: ArchiveHeaderV2): Buffer {
  const body = Buffer.from(JSON.stringify(header), "utf8");
  if (body.length > MAX_HEADER_BYTES) throw new Error("snapshot archive header is too large");
  const length = Buffer.alloc(HEADER_LENGTH_BYTES);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([MAGIC, length, body]);
}

async function readHeader(path: string): Promise<{
  header: ArchiveHeaderV2;
  ciphertextStart: number;
  ciphertextEnd: number;
  authTag: Buffer;
}> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const prefix = Buffer.alloc(MAGIC.length + HEADER_LENGTH_BYTES);
    const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
    if (prefixRead.bytesRead !== prefix.length || !timingSafeEqual(prefix.subarray(0, MAGIC.length), MAGIC)) {
      throw new Error("invalid ClawLore snapshot archive magic");
    }
    const headerBytes = prefix.readUInt32BE(MAGIC.length);
    if (headerBytes <= 0 || headerBytes > MAX_HEADER_BYTES) throw new Error("invalid snapshot archive header length");
    const ciphertextStart = prefix.length + headerBytes;
    const ciphertextEnd = info.size - AUTH_TAG_BYTES - 1;
    if (ciphertextEnd < ciphertextStart) throw new Error("snapshot archive is truncated");
    const body = Buffer.alloc(headerBytes);
    const bodyRead = await handle.read(body, 0, headerBytes, prefix.length);
    if (bodyRead.bytesRead !== headerBytes) throw new Error("snapshot archive header is truncated");
    const parsed = JSON.parse(body.toString("utf8")) as ArchiveHeaderV2;
    if (parsed.schemaVersion !== 1 || parsed.algorithm !== "aes-256-gcm" || !parsed.keyId || !parsed.iv) {
      throw new Error("unsupported snapshot archive header");
    }
    const authTag = Buffer.alloc(AUTH_TAG_BYTES);
    const tagRead = await handle.read(authTag, 0, AUTH_TAG_BYTES, info.size - AUTH_TAG_BYTES);
    if (tagRead.bytesRead !== AUTH_TAG_BYTES) throw new Error("snapshot archive auth tag is truncated");
    return { header: parsed, ciphertextStart, ciphertextEnd, authTag };
  } finally {
    await handle.close();
  }
}

export async function createEncryptedSnapshotArchiveV2(input: {
  sourcePath: string;
  archivePath: string;
  keyProvider: SnapshotArchiveKeyProviderV2;
  now?: () => Date;
}): Promise<EncryptedSnapshotArchiveManifestV2> {
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const plaintextPath = `${input.archivePath}.plaintext-${process.pid}-${randomBytes(8).toString("hex")}.sqlite`;
  await mkdir(dirname(input.archivePath), { recursive: true });
  try {
    const snapshot = await createVerifiedSqliteSnapshotV2({
      sourcePath: input.sourcePath,
      destinationPath: plaintextPath,
      now: () => new Date(createdAt),
    });
    const resolved = await input.keyProvider.current();
    const key = normalizeKey(resolved.key);
    const iv = randomBytes(12);
    const header: ArchiveHeaderV2 = {
      schemaVersion: 1,
      algorithm: "aes-256-gcm",
      keyId: resolved.keyId,
      iv: iv.toString("base64"),
      snapshot,
    };
    await writeFile(input.archivePath, encodeHeader(header), { flag: "wx", mode: 0o600 });
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
      await pipeline(
        createReadStream(plaintextPath),
        cipher,
        createWriteStream(input.archivePath, { flags: "a", mode: 0o600 }),
      );
      await appendFile(input.archivePath, cipher.getAuthTag());
      await chmod(input.archivePath, 0o600);
    } catch (error) {
      await rm(input.archivePath, { force: true });
      throw error;
    }
    const info = await stat(input.archivePath);
    return {
      schemaVersion: 1,
      createdAt,
      algorithm: "aes-256-gcm",
      keyId: resolved.keyId,
      archiveSha256: await sha256File(input.archivePath),
      bytes: info.size,
      snapshot,
    };
  } finally {
    await removeSqliteFiles(plaintextPath);
  }
}

export async function createEncryptedLegacySnapshotArchiveV2(input: {
  sourcePath: string;
  archivePath: string;
  keyProvider: SnapshotArchiveKeyProviderV2;
  now?: () => Date;
}): Promise<EncryptedLegacySnapshotArchiveManifestV2> {
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const plaintextPath = `${input.archivePath}.plaintext-${process.pid}-${randomBytes(8).toString("hex")}.sqlite`;
  await mkdir(dirname(input.archivePath), { recursive: true });
  try {
    const snapshot = await createVerifiedLegacySqliteSnapshotV2({
      sourcePath: input.sourcePath,
      destinationPath: plaintextPath,
      now: () => new Date(createdAt),
    });
    const resolved = await input.keyProvider.current();
    const key = normalizeKey(resolved.key);
    const iv = randomBytes(12);
    const header: ArchiveHeaderV2 = {
      schemaVersion: 1,
      algorithm: "aes-256-gcm",
      keyId: resolved.keyId,
      iv: iv.toString("base64"),
      snapshot,
    };
    await writeFile(input.archivePath, encodeHeader(header), { flag: "wx", mode: 0o600 });
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
      await pipeline(
        createReadStream(plaintextPath),
        cipher,
        createWriteStream(input.archivePath, { flags: "a", mode: 0o600 }),
      );
      await appendFile(input.archivePath, cipher.getAuthTag());
      await chmod(input.archivePath, 0o600);
    } catch (error) {
      await rm(input.archivePath, { force: true });
      throw error;
    }
    const info = await stat(input.archivePath);
    return {
      schemaVersion: 1,
      createdAt,
      algorithm: "aes-256-gcm",
      keyId: resolved.keyId,
      archiveSha256: await sha256File(input.archivePath),
      bytes: info.size,
      snapshot,
    };
  } finally {
    await removeSqliteFiles(plaintextPath);
  }
}

export async function restoreEncryptedSnapshotArchiveV2(input: {
  archivePath: string;
  destinationPath: string;
  expected: EncryptedSnapshotArchiveManifestV2;
  keyProvider: SnapshotArchiveKeyProviderV2;
  now?: () => Date;
}): Promise<SqliteSnapshotManifestV2> {
  if (await sha256File(input.archivePath) !== input.expected.archiveSha256) {
    throw new Error("encrypted snapshot archive checksum mismatch");
  }
  const parsed = await readHeader(input.archivePath);
  if ("profile" in parsed.header.snapshot) {
    throw new Error("encrypted snapshot archive contains a legacy profile");
  }
  if (parsed.header.keyId !== input.expected.keyId
    || parsed.header.snapshot.sha256 !== input.expected.snapshot.sha256
    || parsed.header.snapshot.truthSchemaVersion !== input.expected.snapshot.truthSchemaVersion) {
    throw new Error("encrypted snapshot archive manifest mismatch");
  }
  const resolved = await input.keyProvider.resolve(parsed.header.keyId);
  const key = normalizeKey(resolved.key);
  const iv = Buffer.from(parsed.header.iv, "base64");
  if (iv.length !== 12) throw new Error("invalid snapshot archive IV");
  const plaintextPath = `${input.destinationPath}.decrypt-${process.pid}-${randomBytes(8).toString("hex")}.sqlite`;
  await mkdir(dirname(input.destinationPath), { recursive: true });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(parsed.authTag);
    try {
      await pipeline(
        createReadStream(input.archivePath, { start: parsed.ciphertextStart, end: parsed.ciphertextEnd }),
        decipher,
        createWriteStream(plaintextPath, { flags: "wx", mode: 0o600 }),
      );
    } catch (error) {
      await removeSqliteFiles(plaintextPath);
      throw new Error("encrypted snapshot archive authentication failed", { cause: error });
    }
    const decrypted = await inspectSqliteSnapshotV2(plaintextPath, parsed.header.snapshot.createdAt);
    if (decrypted.sha256 !== parsed.header.snapshot.sha256) throw new Error("decrypted snapshot checksum mismatch");
    return await restoreVerifiedSqliteSnapshotV2({
      snapshotPath: plaintextPath,
      destinationPath: input.destinationPath,
      expected: parsed.header.snapshot,
      now: input.now,
    });
  } finally {
    await removeSqliteFiles(plaintextPath);
  }
}

export async function restoreEncryptedLegacySnapshotArchiveV2(input: {
  archivePath: string;
  destinationPath: string;
  expected: EncryptedLegacySnapshotArchiveManifestV2;
  keyProvider: SnapshotArchiveKeyProviderV2;
  now?: () => Date;
}): Promise<LegacySqliteSnapshotManifestV2> {
  if (await sha256File(input.archivePath) !== input.expected.archiveSha256) {
    throw new Error("encrypted legacy snapshot archive checksum mismatch");
  }
  const parsed = await readHeader(input.archivePath);
  if (!("profile" in parsed.header.snapshot)
    || parsed.header.snapshot.profile !== "scope-recall-legacy-v1") {
    throw new Error("encrypted snapshot archive does not contain a legacy profile");
  }
  if (parsed.header.keyId !== input.expected.keyId
    || parsed.header.snapshot.sha256 !== input.expected.snapshot.sha256
    || parsed.header.snapshot.schemaDigest !== input.expected.snapshot.schemaDigest
    || parsed.header.snapshot.memoryTruth.logicalDigest !== input.expected.snapshot.memoryTruth.logicalDigest) {
    throw new Error("encrypted legacy snapshot archive manifest mismatch");
  }
  const resolved = await input.keyProvider.resolve(parsed.header.keyId);
  const key = normalizeKey(resolved.key);
  const iv = Buffer.from(parsed.header.iv, "base64");
  if (iv.length !== 12) throw new Error("invalid snapshot archive IV");
  const plaintextPath = `${input.destinationPath}.decrypt-${process.pid}-${randomBytes(8).toString("hex")}.sqlite`;
  await mkdir(dirname(input.destinationPath), { recursive: true });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(parsed.authTag);
    try {
      await pipeline(
        createReadStream(input.archivePath, { start: parsed.ciphertextStart, end: parsed.ciphertextEnd }),
        decipher,
        createWriteStream(plaintextPath, { flags: "wx", mode: 0o600 }),
      );
    } catch (error) {
      await removeSqliteFiles(plaintextPath);
      throw new Error("encrypted legacy snapshot archive authentication failed", { cause: error });
    }
    const decrypted = await inspectLegacySqliteSnapshotV2(
      plaintextPath,
      parsed.header.snapshot.createdAt,
    );
    if (decrypted.sha256 !== parsed.header.snapshot.sha256) {
      throw new Error("decrypted legacy snapshot checksum mismatch");
    }
    return await restoreVerifiedLegacySqliteSnapshotV2({
      snapshotPath: plaintextPath,
      destinationPath: input.destinationPath,
      expected: parsed.header.snapshot,
      now: input.now,
    });
  } finally {
    await removeSqliteFiles(plaintextPath);
  }
}
