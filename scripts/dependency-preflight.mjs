import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function inspectDependencyTree(root = process.cwd()) {
  const npmArgs = ["ls", "--all", "--json"];
  const npmExecPath = String(process.env.npm_execpath || "").trim();
  const useWindowsNpmCli = process.platform === "win32" && /npm-cli\.js$/i.test(npmExecPath);
  const result = spawnSync(
    useWindowsNpmCli ? process.execPath : "npm",
    useWindowsNpmCli ? [npmExecPath, ...npmArgs] : npmArgs,
    {
    cwd: resolve(root),
    encoding: "utf8",
    shell: false,
    },
  );
  let report = {};
  try {
    report = JSON.parse(result.stdout || "{}");
  } catch {}
  const problems = Array.isArray(report.problems)
    ? report.problems.map((item) => String(item)).slice(0, 20)
    : [];
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    problems,
    spawnError: result.error ? result.error.name : null,
  };
}

export function assertDependencyTree(root = process.cwd()) {
  const report = inspectDependencyTree(root);
  if (!report.ok) {
    const suffix = report.problems.length > 0 ? ` (${report.problems.join("; ")})` : "";
    throw new Error(
      `release dependency preflight failed; run npm ci --ignore-scripts --include=dev before the source gate${suffix}`,
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assertDependencyTree(process.cwd());
    console.log("release dependency preflight ok");
  } catch (err) {
    console.error(err instanceof Error ? err.message : "release dependency preflight failed");
    process.exit(1);
  }
}
