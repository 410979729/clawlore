import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { diagnosticErrorSummary, diagnosticIdentifier } from "./diagnostic-redaction.js";
import { ensurePrivateDirectory } from "./file-privacy.js";

/** Resolve and validate the private writable storage directory used by projection backends. */
export function validateStoragePath(dbPath: string): string {
  let resolvedPath = dbPath;
  try {
    const stats = lstatSync(dbPath);
    if (stats.isSymbolicLink()) {
      try {
        resolvedPath = realpathSync(dbPath);
      } catch (error: any) {
        throw new Error(
          `CLAWLORE_STORAGE_PATH_INVALID: path=${diagnosticIdentifier(dbPath)} dangling_symlink ${diagnosticErrorSummary(error)}`,
        );
      }
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      // A missing path is created below.
    } else if (
      typeof error?.message === "string"
      && error.message.includes("symlink whose target does not exist")
    ) {
      throw error;
    }
  }

  try {
    ensurePrivateDirectory(resolvedPath);
  } catch (error: any) {
    throw new Error(
      `CLAWLORE_STORAGE_PRIVATE_DIRECTORY_REQUIRED: path=${diagnosticIdentifier(resolvedPath)} parent=${diagnosticIdentifier(dirname(resolvedPath))} ${diagnosticErrorSummary(error)}`,
    );
  }
  try {
    accessSync(resolvedPath, constants.W_OK);
  } catch (error: any) {
    throw new Error(
      `CLAWLORE_STORAGE_NOT_WRITABLE: path=${diagnosticIdentifier(resolvedPath)} ${diagnosticErrorSummary(error)}`,
    );
  }
  return resolvedPath;
}
