import { createRequire } from "node:module";
import { diagnosticErrorSummary } from "./diagnostic-redaction.js";

const require = createRequire(import.meta.url);
let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;

/** Load LanceDB consistently across ESM and Windows CommonJS installations. */
export async function loadLanceDB(): Promise<typeof import("@lancedb/lancedb")> {
  if (!lancedbImportPromise) {
    lancedbImportPromise = Promise.resolve(require("@lancedb/lancedb"));
  }
  try {
    return await lancedbImportPromise;
  } catch (error) {
    throw new Error(
      `CLAWLORE_LANCEDB_LOAD_FAILED: ${diagnosticErrorSummary(error)}`,
      { cause: error },
    );
  }
}
