function optionValue(argv, name) {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return argv[index + 1];
}

export function isCanonicalRuntimePrincipal(value) {
  if (!value || value.length > 512 || value.includes("*") || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1 || second >= value.length - 1) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.slice(0, first))
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.slice(first + 1, second));
}

export function isExactReleaseRef(value) {
  return /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !/[~^:?*\[\\]/.test(value)
    && !/(?:\/|\.|\.lock)$/i.test(value);
}

export function releaseGateEnvironment(argv, baseEnv = process.env) {
  const prePush = argv.includes("--pre-push");
  const principal = optionValue(argv, "--principal")
    ?? (String(baseEnv.CLAWLORE_RUNTIME_PRINCIPAL || "").trim() || undefined);
  const releaseRef = optionValue(argv, "--release-ref")
    ?? (String(baseEnv.CLAWLORE_RELEASE_REF || "").trim() || undefined);
  if (principal && !isCanonicalRuntimePrincipal(principal)) {
    throw new Error("--principal must be an exact platform:account:principal key");
  }
  if (releaseRef && !isExactReleaseRef(releaseRef)) {
    throw new Error("--release-ref must be an exact refs/heads/* or refs/tags/* name");
  }
  if (prePush && releaseRef) {
    throw new Error("--pre-push cannot be combined with --release-ref because it does not verify publication");
  }
  return {
    ...baseEnv,
    CLAWLORE_ALLOW_NESTED_GIT_ROOT: "1",
    ...((argv.includes("--source-only") || prePush) ? { CLAWLORE_SOURCE_ONLY: "1" } : {}),
    ...(prePush ? { CLAWLORE_PRE_PUSH: "1" } : {}),
    ...(principal ? { CLAWLORE_RUNTIME_PRINCIPAL: principal } : {}),
    ...(releaseRef ? { CLAWLORE_RELEASE_REF: releaseRef } : {}),
  };
}

export function assertReleaseDoctor({ report, status, principal }) {
  const accessibility = report?.runtimeAccessibility;
  if (accessibility?.status === "principal_required" && !principal) {
    throw new Error(
      "release gate failed: exact legacy allowlist is configured; rerun with --principal platform:account:principal (or CLAWLORE_RUNTIME_PRINCIPAL)",
    );
  }
  if (accessibility?.status === "migration_required" && principal) {
    throw new Error(
      "release gate failed: the supplied principal cannot access recallable legacy rows; verify the exact allowlist or complete receipt-backed migration",
    );
  }
  if (status !== 0 || report?.ok !== true) {
    const issues = Array.isArray(report?.issues) ? report.issues.join(", ") : "doctor did not report ok=true";
    throw new Error(`release gate failed: OpenClaw runtime doctor blocked: ${issues}`);
  }
  return report;
}
