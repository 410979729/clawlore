import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

const EXCLUDED_AUDIT_LEDGER = Object.freeze([
  "TODO-clawlore.md",
  "docs/clawlore/project-handoff.md",
  "docs/clawlore/eval/",
]);

function runGitText(gitRoot, args) {
  const result = spawnSync("git", args, {
    cwd: gitRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`release input git ${args[0]} failed with ${result.status ?? "unknown status"}`);
  }
  return result.stdout || "";
}

function readGitBlob(gitRoot, objectId) {
  const result = spawnSync("git", ["cat-file", "blob", objectId], {
    cwd: gitRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`release input git cat-file failed with ${result.status ?? "unknown status"}`);
  }
  return result.stdout;
}

function trackedHeadBlobs(gitRoot, diffPathspec) {
  const raw = runGitText(gitRoot, [
    "ls-tree",
    "-r",
    "-z",
    "HEAD",
    "--",
    diffPathspec || ".",
  ]);
  return raw.split("\0").filter(Boolean).map((record) => {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("release input git ls-tree record is malformed");
    const [mode, type, objectId] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (type !== "blob" || !objectId || !path) {
      throw new Error(`release input contains unsupported Git entry: ${mode || "unknown"} ${type || "unknown"}`);
    }
    return { objectId, path };
  });
}

function excluded(sourceRelative) {
  return sourceRelative === EXCLUDED_AUDIT_LEDGER[0]
    || sourceRelative === EXCLUDED_AUDIT_LEDGER[1]
    || sourceRelative.startsWith(EXCLUDED_AUDIT_LEDGER[2]);
}

export function releaseInputIdentity({ gitRoot, sourceRoot, diffPathspec }) {
  const hash = createHash("sha256");
  let fileCount = 0;
  const tracked = trackedHeadBlobs(gitRoot, diffPathspec)
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const entry of tracked) {
    const absolute = resolve(gitRoot, entry.path);
    const sourceRelative = relative(sourceRoot, absolute).replaceAll("\\", "/");
    if (!sourceRelative || sourceRelative.startsWith("../") || excluded(sourceRelative)) continue;
    const content = readGitBlob(gitRoot, entry.objectId);
    hash.update(`${sourceRelative}\u0000${content.length}\u0000`);
    hash.update(content);
    hash.update("\n");
    fileCount++;
  }
  return {
    algorithm: "sha256-git-blobs-release-inputs-v2",
    digest: hash.digest("hex"),
    fileCount,
    excludedAuditLedger: [...EXCLUDED_AUDIT_LEDGER],
  };
}
