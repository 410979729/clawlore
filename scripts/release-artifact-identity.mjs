import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

async function collect(root, current, output) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === "clawlore-build-provenance.json") continue;
    const path = resolve(current, entry.name);
    const name = relative(root, path).split("\\").join("/");
    if (entry.isSymbolicLink()) throw new Error(`runtime artifact contains symlink: ${name}`);
    if (entry.isDirectory()) await collect(root, path, output);
    else if (entry.isFile()) {
      const body = await readFile(path);
      output.push({ path: name, bytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") });
    } else {
      throw new Error(`runtime artifact contains unsupported entry: ${name}`);
    }
  }
}

export async function runtimeArtifactIdentity(root) {
  const resolvedRoot = resolve(root);
  const files = [];
  for (const required of ["package.json", "openclaw.plugin.json"]) {
    const path = resolve(resolvedRoot, required);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`runtime artifact requires regular file: ${required}`);
    }
    const body = await readFile(path);
    files.push({ path: required, bytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") });
  }
  const dist = resolve(resolvedRoot, "dist");
  const distMetadata = await lstat(dist);
  if (!distMetadata.isDirectory() || distMetadata.isSymbolicLink()) {
    throw new Error("runtime artifact requires a regular dist directory");
  }
  await collect(resolvedRoot, dist, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    files,
    digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

export function compareRuntimeArtifactIdentity(candidate, deployed) {
  const candidateByPath = new Map(candidate.files.map((file) => [file.path, file]));
  const deployedByPath = new Map(deployed.files.map((file) => [file.path, file]));
  const missing = [...candidateByPath.keys()].filter((path) => !deployedByPath.has(path)).sort();
  const extra = [...deployedByPath.keys()].filter((path) => !candidateByPath.has(path)).sort();
  const different = [...candidateByPath.keys()].filter((path) => {
    const other = deployedByPath.get(path);
    return other && (other.sha256 !== candidateByPath.get(path).sha256 || other.bytes !== candidateByPath.get(path).bytes);
  }).sort();
  return {
    matches: missing.length === 0 && extra.length === 0 && different.length === 0
      && candidate.digest === deployed.digest,
    candidateDigest: candidate.digest,
    deployedDigest: deployed.digest,
    missing,
    extra,
    different,
  };
}
