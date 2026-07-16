import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

function run(command, args, cwd, capture = false) {
  const npmExecPath = String(process.env.npm_execpath || "").trim();
  const useWindowsNpmCli = process.platform === "win32" && command === "npm" && /npm-cli\.js$/i.test(npmExecPath);
  const result = spawnSync(useWindowsNpmCli ? process.execPath : command, useWindowsNpmCli ? [npmExecPath, ...args] : args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    if (capture && result.stdout) process.stdout.write(result.stdout);
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status ?? "unknown status"}`);
  }
  return result.stdout || "";
}

const sourceRoot = resolve(process.cwd());
const temporaryRoot = await mkdtemp(join(tmpdir(), "clawlore-reproducible-install-"));
const cleanRoot = join(temporaryRoot, "source");
try {
  await cp(sourceRoot, cleanRoot, {
    recursive: true,
    filter(source) {
      const name = basename(source);
      return name !== ".git" && name !== "node_modules";
    },
  });
  run("npm", ["ci", "--ignore-scripts", "--include=dev"], cleanRoot);
  run("npm", ["test"], cleanRoot);
  run("npm", ["run", "typecheck"], cleanRoot);
  run("npm", ["run", "build"], cleanRoot);
  const sbomRaw = run("npm", ["sbom", "--package-lock-only", "--sbom-format", "cyclonedx"], cleanRoot, true);
  const sbom = JSON.parse(sbomRaw);
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new Error("clean install SBOM is missing CycloneDX components");
  }
  const lockDigest = createHash("sha256").update(await readFile(join(cleanRoot, "package-lock.json"))).digest("hex");
  const sbomDigest = createHash("sha256").update(sbomRaw).digest("hex");
  process.stdout.write(`reproducible install gate ok: lock=${lockDigest} sbom=${sbomDigest} components=${sbom.components.length}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
