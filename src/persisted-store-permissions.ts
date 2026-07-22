import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

export interface PersistedStorePermissionInspection {
  ownerOnly: boolean | null;
  files: number;
  directories: number;
  unsafeEntries: number;
}

function inspectEntry(path: string, inspection: PersistedStorePermissionInspection): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    inspection.unsafeEntries += 1;
    inspection.ownerOnly = false;
    return;
  }
  if ((info.mode & 0o077) !== 0) inspection.ownerOnly = false;
  if (info.isFile()) {
    inspection.files += 1;
    return;
  }
  inspection.directories += 1;
  for (const entry of readdirSync(path)) inspectEntry(join(path, entry), inspection);
}

/** Inspect a persisted-store tree without following symlinks. */
export function inspectOwnerOnlyTree(path: string): PersistedStorePermissionInspection {
  if (process.platform === "win32") {
    return { ownerOnly: null, files: 0, directories: 0, unsafeEntries: 0 };
  }
  const inspection: PersistedStorePermissionInspection = {
    ownerOnly: true,
    files: 0,
    directories: 0,
    unsafeEntries: 0,
  };
  inspectEntry(path, inspection);
  return inspection;
}

/** Inspect the SQLite database plus any currently materialized WAL/SHM files. */
export function inspectOwnerOnlySqliteFamily(path: string): PersistedStorePermissionInspection {
  if (process.platform === "win32") {
    return { ownerOnly: null, files: 0, directories: 0, unsafeEntries: 0 };
  }
  const candidates = [path, `${path}-wal`, `${path}-shm`].filter(existsSync);
  const inspections = candidates.map(inspectOwnerOnlyTree);
  return {
    ownerOnly: inspections.every((entry) => entry.ownerOnly === true),
    files: inspections.reduce((sum, entry) => sum + entry.files, 0),
    directories: inspections.reduce((sum, entry) => sum + entry.directories, 0),
    unsafeEntries: inspections.reduce((sum, entry) => sum + entry.unsafeEntries, 0),
  };
}

function tightenEntry(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error("persisted store contains an unsupported or symbolic-link entry");
  }
  if (info.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) tightenEntry(join(path, entry));
    return;
  }
  chmodSync(path, 0o600);
}

/** Tighten an exact persisted-store tree without traversing symlinks. */
export function tightenOwnerOnlyTree(path: string): void {
  if (process.platform !== "win32") tightenEntry(path);
}

export function tightenOwnerOnlySqliteFamily(path: string): void {
  if (process.platform === "win32") return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) tightenEntry(candidate);
  }
}
