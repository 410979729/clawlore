import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { assessRuntimeAccessibility } = jiti("../src/runtime-accessibility-diagnostic.ts");
const { runtimePrincipalIdentity } = jiti("../src/runtime-memory-boundary.ts");

const principal = "telegram:default:8176453077";
const otherPrincipal = "telegram:default:someone-else";

test("default isolation reports legacy migration debt and hides agent scope", () => {
  const identity = runtimePrincipalIdentity(principal);
  const otherIdentity = runtimePrincipalIdentity(otherPrincipal);
  const report = assessRuntimeAccessibility({
    scopeCounts: {
      "agent:main": 100,
      [identity.scope]: 1,
      [otherIdentity.scope]: 17,
      global: 3,
    },
    lifecycleScopeCounts: {
      "agent:main": { recallable: 100, archived: 0, inactive: 0 },
      [identity.scope]: { recallable: 1, archived: 0, inactive: 0 },
      [otherIdentity.scope]: { recallable: 17, archived: 0, inactive: 0 },
      global: { recallable: 3, archived: 0, inactive: 0 },
    },
    principalKey: principal,
  });

  assert.equal(report.status, "migration_required");
  assert.equal(report.blocking, true);
  assert.equal(report.legacy.migrationDebtRows, 100);
  assert.equal(report.principal.scopeRows, 1);
  assert.equal(report.principal.visibleRows, 1);
  assert.deepEqual(report.principal.accessibleScopes, [identity.scope]);
  assert.equal(report.principal.legacyScopeAccessible, false);
});

test("an exact temporary allowlist restores legacy visibility without cross-principal leakage", () => {
  const identity = runtimePrincipalIdentity(principal);
  const otherIdentity = runtimePrincipalIdentity(otherPrincipal);
  const report = assessRuntimeAccessibility({
    scopeCounts: {
      "agent:main": 100,
      [identity.scope]: 1,
      [otherIdentity.scope]: 17,
      global: 3,
    },
    lifecycleScopeCounts: {
      "agent:main": { recallable: 100, archived: 0, inactive: 0 },
      [identity.scope]: { recallable: 1, archived: 0, inactive: 0 },
      [otherIdentity.scope]: { recallable: 17, archived: 0, inactive: 0 },
      global: { recallable: 3, archived: 0, inactive: 0 },
    },
    principalIsolation: {
      legacyAgentScopePrincipals: [principal],
    },
    principalKey: principal,
  });

  assert.equal(report.status, "ready");
  assert.equal(report.blocking, false);
  assert.equal(report.legacy.decision, "exact_allowlist");
  assert.equal(report.principal.visibleRows, 101);
  assert.deepEqual(report.principal.accessibleScopes, [identity.scope, "agent:main"]);
  assert.equal(report.principal.accessibleScopes.includes(otherIdentity.scope), false);
  assert.equal(report.principal.accessibleScopes.includes("global"), false);
});

test("doctor-style assessment requires a principal when legacy rows use an allowlist", () => {
  const report = assessRuntimeAccessibility({
    scopeCounts: { "agent:main": 100 },
    principalIsolation: {
      legacyAgentScopePrincipals: [principal],
    },
  });

  assert.equal(report.status, "principal_required");
  assert.equal(report.blocking, true);
  assert.equal(report.legacy.rows, 100);
  assert.equal(report.isolation.legacyAllowlistPrincipalCount, 1);
  assert.equal("principal" in report, false);
});

test("archived-only legacy rows are reported separately and create no migration debt", () => {
  const report = assessRuntimeAccessibility({
    scopeCounts: { "agent:main": 320 },
    lifecycleScopeCounts: {
      "agent:main": { recallable: 0, archived: 320, inactive: 0 },
    },
    principalKey: principal,
  });

  assert.equal(report.status, "ready");
  assert.equal(report.blocking, false);
  assert.equal(report.legacy.rows, 320);
  assert.equal(report.legacy.archivedRows, 320);
  assert.equal(report.legacy.migrationDebtRows, 0);
  assert.equal(report.principal.visibleRows, 0);
});

test("mixed lifecycle counts expose only recallable rows and debt", () => {
  const identity = runtimePrincipalIdentity(principal);
  const report = assessRuntimeAccessibility({
    scopeCounts: { "agent:main": 1061, [identity.scope]: 4 },
    lifecycleScopeCounts: {
      "agent:main": { recallable: 650, archived: 320, inactive: 91 },
      [identity.scope]: { recallable: 2, archived: 1, inactive: 1 },
    },
    principalIsolation: { legacyAgentScopePrincipals: [principal] },
    principalKey: principal,
  });

  assert.equal(report.legacy.migrationDebtRows, 650);
  assert.equal(report.legacy.archivedRows, 320);
  assert.equal(report.principal.recallableScopeRows, 2);
  assert.equal(report.principal.visibleRows, 652);
  assert.equal(report.principal.archivedRows, 321);
});
