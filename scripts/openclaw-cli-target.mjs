import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

function isBooleanSentinel(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function packageCandidateFromCli(command, pathApi) {
  const normalized = String(command ?? "").trim();
  if (!normalized || isBooleanSentinel(normalized)) return "";
  const basename = pathApi.basename(normalized).toLowerCase();
  if (basename === "openclaw.mjs") return pathApi.dirname(normalized);
  if (
    ["openclaw", "openclaw.cmd", "openclaw.ps1"].includes(basename)
    && pathApi.basename(pathApi.dirname(normalized)).toLowerCase() === ".bin"
  ) {
    return pathApi.resolve(pathApi.dirname(normalized), "..", "openclaw");
  }
  return "";
}

function isOpenClawPackage(path, pathApi, exists) {
  return Boolean(path)
    && exists(pathApi.resolve(path, "package.json"))
    && exists(pathApi.resolve(path, "openclaw.mjs"));
}

/**
 * Resolve the host OpenClaw package across both supported state layouts.
 *
 * Linux service installs commonly use `<root>/home/state` with `<root>/app`,
 * while Windows installs use sibling `<root>/state` and `<root>/app`
 * directories. An explicit package or CLI path remains authoritative. Without
 * one, exactly one valid inferred package must exist so a stray second install
 * cannot silently become the release-smoke target.
 */
export function resolveOpenClawPackageTarget(options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const exists = options.exists ?? existsSync;
  const stateDir = String(options.stateDir ?? "").trim();
  if (!stateDir) {
    throw new Error("release gate failed: OpenClaw state directory is required");
  }

  const configuredPackage = String(options.configuredPackage ?? "").trim();
  if (configuredPackage) {
    const candidate = pathApi.resolve(configuredPackage);
    if (!isOpenClawPackage(candidate, pathApi, exists)) {
      throw new Error("release gate failed: configured OpenClaw package is invalid");
    }
    return candidate;
  }

  const cliCandidate = packageCandidateFromCli(options.configuredCli, pathApi);
  if (cliCandidate) {
    if (!isOpenClawPackage(cliCandidate, pathApi, exists)) {
      throw new Error("release gate failed: configured OpenClaw CLI package is invalid");
    }
    return cliCandidate;
  }

  const candidates = [
    pathApi.resolve(stateDir, "..", "app", "node_modules", "openclaw"),
    pathApi.resolve(stateDir, "..", "..", "app", "node_modules", "openclaw"),
  ];
  const unique = [...new Map(
    candidates.map((candidate) => [
      platform === "win32" ? candidate.toLowerCase() : candidate,
      candidate,
    ]),
  ).values()];
  const existing = unique.filter((candidate) => isOpenClawPackage(candidate, pathApi, exists));
  if (existing.length === 0) {
    throw new Error("release gate failed: OpenClaw package is missing from supported state layouts");
  }
  if (existing.length > 1) {
    throw new Error("release gate failed: OpenClaw package inference is ambiguous");
  }
  return existing[0];
}

export function openClawCliForPackage(packageRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  return pathApi.resolve(
    packageRoot,
    "..",
    ".bin",
    platform === "win32" ? "openclaw.cmd" : "openclaw",
  );
}

/**
 * Resolve OpenClaw's npm shim without invoking a command shell.
 *
 * Windows cannot spawn a `.cmd` file with `shell: false`. The canonical npm
 * shim is therefore mapped to the package's JavaScript entry point, preserving
 * the release gate's no-shell boundary.
 */
export function resolveOpenClawCliTarget(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const pathApi = platform === "win32" ? win32 : posix;
  const exists = options.exists ?? existsSync;

  if (/\.(?:c?js|mjs)$/i.test(command)) {
    return { command: nodeExecutable, args: [command, ...args] };
  }
  if (platform !== "win32" || !/\.cmd$/i.test(command)) {
    return { command, args };
  }
  if (pathApi.basename(command).toLowerCase() !== "openclaw.cmd") {
    throw new Error("release gate failed: unsupported Windows OpenClaw command shim");
  }

  const entry = pathApi.resolve(
    pathApi.dirname(command),
    "..",
    "openclaw",
    "openclaw.mjs",
  );
  if (!exists(entry)) {
    throw new Error("release gate failed: Windows OpenClaw package entry is missing");
  }
  return { command: nodeExecutable, args: [entry, ...args] };
}
