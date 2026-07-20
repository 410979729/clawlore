import {
  isCanonicalPrincipalKey,
  normalizePrincipalIsolationConfig,
  runtimePrincipalIdentity,
  type PrincipalIsolationConfig,
} from "./runtime-memory-boundary.js";

type LifecycleScopeCounts = Record<string, {
  recallable: number;
  archived: number;
  inactive: number;
}>;

export type RuntimeAccessibilityStatus =
  | "ready"
  | "isolation_disabled"
  | "migration_required"
  | "principal_required";

export interface RuntimeAccessibilityDiagnostic {
  status: RuntimeAccessibilityStatus;
  blocking: boolean;
  agentId: string;
  isolation: {
    enabled: boolean;
    groupMemory: "deny" | "conversation";
    allowGlobalRead: boolean;
    legacyAllowlistPrincipalCount: number;
  };
  legacy: {
    scope: string;
    rows: number;
    recallableRows: number;
    archivedRows: number;
    inactiveRows: number;
    migrationDebtRows: number;
    decision: "not_required" | "migration_required" | "exact_allowlist" | "isolation_disabled";
  };
  principal?: {
    principalHash: string;
    scope: string;
    scopeRows: number;
    recallableScopeRows: number;
    visibleRows: number;
    archivedRows: number;
    accessibleScopes: string[];
    legacyScopeAccessible: boolean;
  };
}

function safeCount(scopeCounts: Record<string, number>, scope: string): number {
  const value = scopeCounts[scope];
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function lifecycleCount(
  stats: LifecycleScopeCounts | undefined,
  scopeCounts: Record<string, number>,
  scope: string,
  lifecycle: "recallable" | "archived" | "inactive",
): number {
  if (!stats?.[scope]) return lifecycle === "recallable" ? safeCount(scopeCounts, scope) : 0;
  return safeCount({ value: stats[scope][lifecycle] }, "value");
}

function normalizedAgentId(value: string | undefined): string {
  const agentId = value?.trim() || "main";
  if (/[:\s\u0000-\u001f\u007f]/.test(agentId)) {
    throw new Error("agentId must be a non-empty scope-safe identifier");
  }
  return agentId;
}

export function assessRuntimeAccessibility(input: {
  scopeCounts: Record<string, number>;
  lifecycleScopeCounts?: LifecycleScopeCounts;
  agentId?: string;
  principalIsolation?: PrincipalIsolationConfig;
  principalKey?: string;
}): RuntimeAccessibilityDiagnostic {
  const agentId = normalizedAgentId(input.agentId);
  const isolation = normalizePrincipalIsolationConfig(input.principalIsolation);
  const legacyScope = `agent:${agentId}`;
  const legacyRows = safeCount(input.scopeCounts, legacyScope);
  const legacyRecallableRows = lifecycleCount(input.lifecycleScopeCounts, input.scopeCounts, legacyScope, "recallable");
  const legacyArchivedRows = lifecycleCount(input.lifecycleScopeCounts, input.scopeCounts, legacyScope, "archived");
  const legacyInactiveRows = lifecycleCount(input.lifecycleScopeCounts, input.scopeCounts, legacyScope, "inactive");

  if (input.principalKey !== undefined && !isCanonicalPrincipalKey(input.principalKey)) {
    throw new Error("principalKey must be an exact canonical platform:account:principal key");
  }

  const principalIdentity = input.principalKey
    ? runtimePrincipalIdentity(input.principalKey)
    : undefined;
  const legacyScopeAccessible = Boolean(
    input.principalKey
    && isolation.legacyAgentScopePrincipals.includes(input.principalKey),
  );
  const accessibleScopes = principalIdentity
    ? [
      principalIdentity.scope,
      ...(legacyScopeAccessible ? [legacyScope] : []),
      ...(isolation.allowGlobalRead ? ["global"] : []),
    ]
    : [];
  const visibleRows = accessibleScopes.reduce(
    (total, scope) => total + lifecycleCount(input.lifecycleScopeCounts, input.scopeCounts, scope, "recallable"),
    0,
  );
  const archivedRows = accessibleScopes.reduce(
    (total, scope) => total + lifecycleCount(input.lifecycleScopeCounts, input.scopeCounts, scope, "archived"), 0,
  );

  let status: RuntimeAccessibilityStatus = "ready";
  let blocking = false;
  let decision: RuntimeAccessibilityDiagnostic["legacy"]["decision"] = "not_required";

  if (!isolation.enabled) {
    status = "isolation_disabled";
    decision = "isolation_disabled";
  } else if (legacyRecallableRows > 0 && legacyScopeAccessible) {
    decision = "exact_allowlist";
  } else if (legacyRecallableRows > 0 && input.principalKey) {
    status = "migration_required";
    blocking = true;
    decision = "migration_required";
  } else if (legacyRecallableRows > 0 && isolation.legacyAgentScopePrincipals.length > 0) {
    status = "principal_required";
    blocking = true;
    decision = "exact_allowlist";
  } else if (legacyRecallableRows > 0) {
    status = "migration_required";
    blocking = true;
    decision = "migration_required";
  }

  return {
    status,
    blocking,
    agentId,
    isolation: {
      enabled: isolation.enabled,
      groupMemory: isolation.groupMemory,
      allowGlobalRead: isolation.allowGlobalRead,
      legacyAllowlistPrincipalCount: isolation.legacyAgentScopePrincipals.length,
    },
    legacy: {
      scope: legacyScope,
      rows: legacyRows,
      recallableRows: legacyRecallableRows,
      archivedRows: legacyArchivedRows,
      inactiveRows: legacyInactiveRows,
      migrationDebtRows: legacyRecallableRows,
      decision,
    },
    ...(principalIdentity
      ? {
        principal: {
          ...principalIdentity,
          scopeRows: safeCount(input.scopeCounts, principalIdentity.scope),
          recallableScopeRows: lifecycleCount(input.lifecycleScopeCounts, input.scopeCounts, principalIdentity.scope, "recallable"),
          visibleRows,
          archivedRows,
          accessibleScopes,
          legacyScopeAccessible,
        },
      }
      : {}),
  };
}
