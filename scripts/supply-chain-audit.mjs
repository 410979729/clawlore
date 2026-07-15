import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_AUDIT_REGISTRY = "https://registry.npmjs.org";

export function interpretAuditResult(result) {
  let report = null;
  try {
    report = JSON.parse(result.stdout || "null");
  } catch {}
  const vulnerabilities = report?.metadata?.vulnerabilities ?? null;
  const total = vulnerabilities && typeof vulnerabilities.total === "number"
    ? vulnerabilities.total
    : null;
  if (result.status === 0 && total === 0) {
    return { ok: true, vulnerabilities: 0, reason: null };
  }
  if (total !== null && total > 0) {
    return { ok: false, vulnerabilities: total, reason: "vulnerabilities_found" };
  }
  return { ok: false, vulnerabilities: total, reason: "audit_endpoint_or_transport_failure" };
}

export function runSupplyChainAudit(root = process.cwd(), registry = DEFAULT_AUDIT_REGISTRY) {
  const result = spawnSync(
    "npm",
    ["audit", "--json", "--omit=dev", `--registry=${registry}`],
    { cwd: resolve(root), encoding: "utf8", shell: false },
  );
  const verdict = interpretAuditResult(result);
  if (!verdict.ok) {
    throw new Error(`release supply-chain audit failed: ${verdict.reason}`);
  }
  return verdict;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const registry = process.env.CLAWLORE_AUDIT_REGISTRY || DEFAULT_AUDIT_REGISTRY;
    const result = runSupplyChainAudit(process.cwd(), registry);
    console.log(`release supply-chain audit ok: vulnerabilities=${result.vulnerabilities}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "release supply-chain audit failed");
    process.exit(1);
  }
}
