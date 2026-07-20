import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactBinding, releaseProvenance } from "./fixtures/release-provenance.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { registerDiagnosticCommands } = jiti("../src/cli/diagnostic-commands.ts");
const { canonicalDigest } = jiti("../src/release-provenance.ts");
const { buildReleaseReadinessReceipt } = jiti("../src/v2/application/release-readiness.ts");
const {
  buildRuntimeDiagnosticReceipt,
  writeRuntimeDiagnosticReceipt,
} = jiti("../src/runtime-diagnostic-receipt.ts");

function experienceDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE task_episodes (status TEXT);
    CREATE TABLE procedural_playbooks (status TEXT);
    CREATE VIRTUAL TABLE procedural_playbooks_fts USING fts5(text);
    CREATE TABLE playbook_versions (id TEXT);
    CREATE TABLE experience_runs (outcome TEXT);
    CREATE TABLE task_experience_capture_events (action TEXT, reason TEXT);
  `);
  return db;
}

class FixtureCommand {
  constructor(name = "") {
    this.commandName = name;
    this.children = [];
  }
  command(name) {
    const child = new FixtureCommand(name);
    this.children.push(child);
    return child;
  }
  description() { return this; }
  option() { return this; }
  action(handler) { this.handler = handler; return this; }
}

test("doctor reports the persisted runtime registration truth", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-doctor-runtime-"));
  const db = experienceDb();
  const previousExitCode = process.exitCode;
  const previousWrite = process.stdout.write;
  let output = "";
  try {
    const now = new Date();
    const pluginConfig = { runtime: { mode: "shadow", contextEngine: "compatibility" } };
    const configDigest = canonicalDigest(pluginConfig);
    const currentBinding = { ...artifactBinding(), configDigest };
    const releaseReceipt = buildReleaseReadinessReceipt({
      rolloutId: "doctor-runtime-fixture",
      requestedMode: "shadow",
      currentMode: "shadow",
      evidence: {
        focusedTests: true, fullTests: true, typecheck: true, build: true,
        moduleBoundaries: true, releaseGate: true, snapshotVerified: false,
        migrationDrill: false, rollbackDrill: false, legacyHashUnchanged: false,
        forbiddenScopeViolations: 0,
      },
      provenance: {
        ...releaseProvenance(),
        configDigest,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      },
      now: () => new Date(now.getTime() - 1_000),
    });
    const runtimeDiagnosticFile = join(root, "runtime.json");
    await writeRuntimeDiagnosticReceipt(runtimeDiagnosticFile, buildRuntimeDiagnosticReceipt({
      configDigest,
      binding: currentBinding,
      readiness: releaseReceipt,
      readinessErrors: [],
      runtime: {
        status: "registered",
        requestedMode: "shadow",
        registeredHooks: ["message_received"],
        writeEnabled: false,
        promptMutationEnabled: false,
        contextEngineRegistered: false,
        blockingReasons: [],
      },
      now: () => now,
    }));

    const program = new FixtureCommand("root");
    const memory = new FixtureCommand("clawlore");
    registerDiagnosticCommands({
      program,
      memory,
      context: {
        pluginConfig,
        runtimeDiagnosticFile,
        store: {
          async stats() { return { scopeCounts: {}, categoryCounts: {}, lifecycleScopeCounts: {} }; },
          async verifyFilePrivacy() {},
          getDiagnostics() {
            return {
              sqlTruth: { available: true, count: 0, fts: { healthy: true } },
              fts: { healthy: true },
              vectorCompanion: {
                backend: "sqlite-bruteforce",
                configuredDimension: 64,
                needsRepair: false,
              },
            };
          },
          async getVectorCompanionDriftReport() {
            return { sqlRows: 0, vectorRows: 0, missingVectorRows: 0, staleVectorRows: 0 };
          },
          async getVectorScopeCounts() { return {}; },
          async getSqlTruthDb() { return db; },
        },
        scopeManager: { getStats() { return { totalScopes: 0 }; } },
      },
    });

    process.exitCode = undefined;
    process.stdout.write = ((chunk) => {
      output += String(chunk);
      return true;
    });
    const doctor = memory.children.find((command) => command.commandName === "doctor");
    assert.equal(typeof doctor?.handler, "function");
    await doctor.handler({ json: true, quiet: true, agentId: "main" });
    const report = JSON.parse(output);
    assert.equal(report.ok, true);
    assert.equal(report.runtimeDiagnostic.ok, true);
    assert.equal(report.runtimeDiagnostic.status, "registered");
    assert.equal(report.runtimeDiagnostic.receipt.runtime.registeredHookCount, 1);
    assert.equal(report.runtimeDiagnostic.receipt.readiness.bindingVerified, true);

    pluginConfig.autoBackup = true;
    output = "";
    process.exitCode = undefined;
    await doctor.handler({ json: true, quiet: true, agentId: "main" });
    const deprecatedReport = JSON.parse(output);
    assert.equal(deprecatedReport.ok, false);
    assert.equal(deprecatedReport.configuration.deprecatedAutoBackupEnabled, true);
    assert.equal(deprecatedReport.issues.some((issue) => issue.includes("autoBackup=true does not create backups")), true);
  } finally {
    process.stdout.write = previousWrite;
    process.exitCode = previousExitCode;
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
