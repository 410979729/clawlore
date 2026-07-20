export const ALLOWED_PLATFORM_VARIANCE = Object.freeze([
  "observedCommit",
  "sbom.componentCount",
  "sbom.sha256",
  "sbom.toolVersion",
  "toolchain.node",
  "toolchain.npm",
  "toolchain.os",
  "toolchain.arch",
]);

export function stableReleaseEvidence(value) {
  return {
    schema: value.schema,
    package: value.package,
    releaseInput: value.releaseInput,
    runtimeDigest: value.runtimeDigest,
    sourceOnly: value.sourceOnly,
    publicationVerified: value.publicationVerified,
    dirty: value.dirty,
    packFileCount: value.packFileCount,
    packageLockSha256: value.packageLockSha256,
    sbom: {
      format: value.sbom?.format,
      specVersion: value.sbom?.specVersion,
      tool: value.sbom?.tool,
    },
    compatibility: value.compatibility,
    supplyChainRegistry: value.supplyChainRegistry,
    packedRuntimeSmoke: value.packedRuntimeSmoke,
    packedLanceDbSmoke: value.packedLanceDbSmoke,
    packedOpenClawCliSmoke: value.packedOpenClawCliSmoke,
    allowedPlatformVariance: value.allowedPlatformVariance,
  };
}

export function stableReleaseEvidenceMatches(left, right) {
  return JSON.stringify(stableReleaseEvidence(left)) === JSON.stringify(stableReleaseEvidence(right));
}
