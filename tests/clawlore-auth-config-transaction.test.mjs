import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  buildOauthLlmBackup,
  ensurePluginConfigRoot,
  getExistingPluginConfigRoot,
  getOauthBackupPath,
  getOpenClawConfigBackupPath,
  loadOauthLlmBackup,
  loadOpenClawConfig,
  performOAuthLogoutConfigTransaction,
  planOAuthLoginConfig,
  prepareOAuthLoginBackup,
  saveOauthLlmBackup,
  saveOpenClawConfig,
} = jiti("../src/cli/cli-runtime-policy.ts");
const {
  verifyPrivatePath,
  writePrivateFileAtomic,
} = jiti("../src/file-privacy.ts");

const secretRef = Object.freeze({ source: "file", provider: "runtime", id: "/llm-api-key" });

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function tempRoot(name) {
  return mkdtempSync(join(tmpdir(), name));
}

async function writePrivateJson(path, value) {
  await writePrivateFileAtomic(path, json(value));
}

function liveLikePluginConfig() {
  const config = {
    admissionControl: { enabled: true },
    autoBackup: false,
    autoCapture: true,
    autoRecall: true,
    autoRecallMaxChars: 4000,
    autoRecallMaxItems: 6,
    autoRecallMinLength: 6,
    autoRecallMinRepeated: 2,
    autoRecallPerItemMaxChars: 800,
    autoRecallTimeoutMs: 5000,
    dbPath: "/private/live-memory",
    embedding: { provider: "local-hash" },
    enableManagementTools: true,
    extractMaxChars: 12000,
    extractMinMessages: 4,
    extractionThrottle: { skipLowValue: true },
    llm: { auth: "api-key", apiKey: secretRef, model: "fixture-model" },
    maxRecallPerTurn: 10,
    mdMirror: { enabled: false },
    memoryCompaction: { enabled: false },
    recallMode: "summary",
    retrieval: { mode: "hybrid" },
    runtime: { mode: "shadow", contextEngine: "compatibility" },
    sessionCompression: { enabled: false },
    sessionMemory: { enabled: true },
    sessionStrategy: "memoryReflection",
    smartExtraction: true,
    taskExperienceCapture: { enabled: true },
    vectorBackend: "lancedb",
    workspaceBoundary: { userMdExclusive: { enabled: true } },
  };
  assert.equal(Object.keys(config).length, 30);
  return config;
}

function legacyConfig(pluginConfig = liveLikePluginConfig()) {
  return {
    plugins: {
      allow: ["telegram", "scope-recall-openclaw", "openai"],
      entries: {
        "scope-recall-openclaw": { enabled: true, config: pluginConfig },
      },
      slots: { memory: "scope-recall-openclaw" },
    },
  };
}

function oauthConfig(oauthPath) {
  return {
    plugins: {
      allow: ["clawlore"],
      entries: {
        clawlore: {
          enabled: true,
          config: {
            embedding: { provider: "local-hash" },
            llm: {
              auth: "oauth",
              oauthProvider: "openai-codex",
              oauthPath,
              model: "openai/gpt-5.6-sol",
            },
          },
        },
      },
      slots: { memory: "clawlore" },
    },
  };
}

async function createLogoutFixture(label = "clawlore-auth-logout-") {
  const root = tempRoot(label);
  const configPath = join(root, "openclaw.json");
  const oauthPath = join(root, ".clawlore", "oauth.json");
  const originalApiKeyLlm = {
    auth: "api-key",
    apiKey: secretRef,
    baseURL: "https://example.invalid/v1",
    model: "fixture-api-key-model",
    timeoutMs: 30_000,
  };
  await writePrivateJson(configPath, oauthConfig(oauthPath));
  await writePrivateFileAtomic(oauthPath, json({ access_token: "fixture-oauth-authority" }));
  await saveOauthLlmBackup(oauthPath, originalApiKeyLlm, true);
  return { root, configPath, oauthPath, originalApiKeyLlm };
}

function assertNoTempFiles(root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else assert.equal(entry.name.endsWith(".tmp"), false, path);
    }
  };
  visit(root);
}

function assertAtLeastOneAuthMode(configPath, oauthPath) {
  const config = readJson(configPath);
  const llm = config.plugins.entries.clawlore.config.llm;
  if (llm?.auth === "oauth") {
    assert.equal(existsSync(oauthPath), true);
    return "oauth";
  }
  assert.deepEqual(llm?.apiKey, secretRef);
  return "api-key";
}

test("OAuth backup round-trips only a schema-valid API-key SecretRef", async () => {
  const root = tempRoot("clawlore-auth-secretref-");
  const oauthPath = join(root, ".clawlore", "oauth.json");
  try {
    const llm = {
      auth: "api-key",
      apiKey: secretRef,
      baseURL: "https://example.invalid/v1",
      model: "fixture-model",
      timeoutMs: 1234,
    };
    await saveOauthLlmBackup(oauthPath, llm, true);
    assert.deepEqual(await loadOauthLlmBackup(oauthPath), {
      version: 2,
      hadLlmConfig: true,
      llm,
    });
    verifyPrivatePath(dirname(getOauthBackupPath(oauthPath)), { kind: "directory" });
    verifyPrivatePath(getOauthBackupPath(oauthPath), { kind: "file" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OAuth backup refuses plaintext or malformed API keys without writing a backup", async () => {
  const root = tempRoot("clawlore-auth-plaintext-");
  const oauthPath = join(root, ".clawlore", "oauth.json");
  try {
    for (const apiKey of [
      "plaintext-canary",
      { source: "file", provider: "runtime" },
      { source: "env", provider: "runtime", id: "lowercase_is_invalid" },
      { source: "file", provider: "runtime", id: "not-a-json-pointer" },
      { source: "file", provider: "runtime", id: "/invalid~2escape" },
      { source: "exec", provider: "runtime", id: "vault/../api-key" },
    ]) {
      await assert.rejects(
        saveOauthLlmBackup(oauthPath, { auth: "api-key", apiKey }, true),
        /CLAWLORE_OAUTH_API_KEY_BACKUP_(?:REQUIRES_SECRETREF|SECRETREF_INVALID)/,
      );
      assert.equal(existsSync(getOauthBackupPath(oauthPath)), false);
    }
    assert.throws(
      () => buildOauthLlmBackup({ auth: "api-key", apiKey: "plaintext-canary" }, true),
      /CLAWLORE_OAUTH_API_KEY_BACKUP_REQUIRES_SECRETREF/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OAuth backup accepts the exact OpenClaw env, file, and exec SecretRef grammars", () => {
  for (const apiKey of [
    { source: "env", provider: "default", id: "CLAWLORE_LLM_API_KEY" },
    { source: "file", provider: "mounted-json", id: "/providers/openai~1codex/apiKey" },
    { source: "file", provider: "single-value", id: "value" },
    { source: "exec", provider: "vault", id: "openai/api-key#value" },
  ]) {
    assert.deepEqual(
      buildOauthLlmBackup({ auth: "api-key", apiKey }, true).llm.apiKey,
      apiKey,
    );
  }
});

test("OAuth re-login validates and carries the API-key backup when oauthPath changes", async () => {
  const root = tempRoot("clawlore-auth-relogin-path-");
  const configPath = join(root, "openclaw.json");
  const sourceOauthPath = join(root, ".clawlore", "old-oauth.json");
  const targetOauthPath = join(root, ".clawlore", "new-oauth.json");
  const originalLlm = { auth: "api-key", apiKey: secretRef, model: "fixture-api-key-model" };
  try {
    await saveOauthLlmBackup(sourceOauthPath, originalLlm, true);
    const loginPlan = planOAuthLoginConfig({
      llm: {
        auth: "oauth",
        oauthProvider: "openai-codex",
        oauthPath: sourceOauthPath,
        model: "openai/gpt-5.6-sol",
      },
      providerId: "openai-codex",
      model: "openai/gpt-5.6-sol",
      oauthPath: targetOauthPath,
    });
    const backupPlan = await prepareOAuthLoginBackup({
      configPath,
      targetOauthPath,
      loginPlan,
    });
    assert.equal(backupPlan.writeBackup, true);
    assert.equal(backupPlan.sourceOauthPath, sourceOauthPath);
    assert.deepEqual(backupPlan.llm, originalLlm);
    await saveOauthLlmBackup(targetOauthPath, backupPlan.llm, backupPlan.hadLlmConfig);
    assert.deepEqual(await loadOauthLlmBackup(targetOauthPath), {
      version: 2,
      hadLlmConfig: true,
      llm: originalLlm,
    });

    const samePathPlan = await prepareOAuthLoginBackup({
      configPath,
      targetOauthPath: sourceOauthPath,
      loginPlan,
    });
    assert.equal(samePathPlan.writeBackup, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OAuth re-login fails before authorization when no restorable backup exists", async () => {
  const root = tempRoot("clawlore-auth-relogin-missing-");
  const configPath = join(root, "openclaw.json");
  const oauthPath = join(root, ".clawlore", "oauth.json");
  try {
    const loginPlan = planOAuthLoginConfig({
      llm: { auth: "oauth", oauthPath, model: "openai/gpt-5.6-sol" },
      providerId: "openai-codex",
      model: "openai/gpt-5.6-sol",
      oauthPath,
    });
    await assert.rejects(
      prepareOAuthLoginBackup({ configPath, targetOauthPath: oauthPath, loginPlan }),
      /CLAWLORE_OAUTH_RELOGIN_BACKUP_REQUIRED/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy-only identity migration preserves the complete entry, allowlist, slot, and SecretRef", () => {
  const config = legacyConfig();
  const expectedEntry = structuredClone(config.plugins.entries["scope-recall-openclaw"]);
  const pluginConfig = ensurePluginConfigRoot(config, "clawlore");
  assert.equal(config.plugins.entries["scope-recall-openclaw"], undefined);
  assert.deepEqual(config.plugins.entries.clawlore, expectedEntry);
  assert.strictEqual(pluginConfig, config.plugins.entries.clawlore.config);
  assert.deepEqual(pluginConfig.llm.apiKey, secretRef);
  assert.equal(Object.keys(pluginConfig).length, 30);
  assert.deepEqual(config.plugins.allow, ["telegram", "clawlore", "openai"]);
  assert.equal(config.plugins.slots.memory, "clawlore");
});

test("conflicting dual identity fails closed without mutating the raw config", () => {
  const config = legacyConfig();
  config.plugins.entries.clawlore = {
    enabled: true,
    config: { embedding: { provider: "local-hash" }, llm: { auth: "oauth" } },
  };
  const before = structuredClone(config);
  assert.throws(
    () => ensurePluginConfigRoot(config, "clawlore"),
    /CLAWLORE_PLUGIN_IDENTITY_CONFLICT/,
  );
  assert.deepEqual(config, before);
  assert.throws(
    () => getExistingPluginConfigRoot(config, "clawlore"),
    /CLAWLORE_PLUGIN_IDENTITY_CONFLICT/,
  );
});

test("equivalent dual identity collapses to one canonical entry", () => {
  const config = legacyConfig();
  config.plugins.entries.clawlore = structuredClone(config.plugins.entries["scope-recall-openclaw"]);
  ensurePluginConfigRoot(config, "clawlore");
  assert.deepEqual(Object.keys(config.plugins.entries), ["clawlore"]);
  assert.equal(config.plugins.slots.memory, "clawlore");
});

test("legacy API-key config survives a canonical OAuth login/logout round-trip", async () => {
  const root = tempRoot("clawlore-auth-roundtrip-");
  const configPath = join(root, "openclaw.json");
  const oauthPath = join(root, ".clawlore", "oauth.json");
  const original = legacyConfig();
  const originalLlm = structuredClone(original.plugins.entries["scope-recall-openclaw"].config.llm);
  try {
    await writePrivateJson(configPath, original);
    const loginConfig = await loadOpenClawConfig(configPath);
    const pluginConfig = ensurePluginConfigRoot(loginConfig, "clawlore");
    const plan = planOAuthLoginConfig({
      llm: pluginConfig.llm,
      providerId: "openai-codex",
      model: "openai/gpt-5.6-sol",
      oauthPath,
    });
    const backupPlan = await prepareOAuthLoginBackup({
      configPath,
      targetOauthPath: oauthPath,
      loginPlan: plan,
    });
    await saveOauthLlmBackup(oauthPath, backupPlan.llm, backupPlan.hadLlmConfig);
    pluginConfig.llm = plan.nextLlm;
    await saveOpenClawConfig(configPath, loginConfig);
    await writePrivateFileAtomic(oauthPath, json({ access_token: "fixture-oauth-authority" }));

    await performOAuthLogoutConfigTransaction({ configPath, pluginId: "clawlore" });
    const restored = readJson(configPath);
    assert.deepEqual(Object.keys(restored.plugins.entries), ["clawlore"]);
    assert.equal(restored.plugins.slots.memory, "clawlore");
    assert.equal(Object.keys(restored.plugins.entries.clawlore.config).length, 30);
    assert.deepEqual(restored.plugins.entries.clawlore.config.llm, originalLlm);
    assert.deepEqual(restored.plugins.entries.clawlore.config.llm.apiKey, secretRef);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw config replacement is private, atomic, validated, and backup-backed", async () => {
  const root = tempRoot("clawlore-auth-config-save-");
  const configPath = join(root, "openclaw.json");
  const oldConfig = legacyConfig();
  const nextConfig = structuredClone(oldConfig);
  ensurePluginConfigRoot(nextConfig, "clawlore");
  try {
    await writePrivateJson(configPath, oldConfig);
    const result = await saveOpenClawConfig(configPath, nextConfig);
    assert.deepEqual(await loadOpenClawConfig(configPath), nextConfig);
    assert.equal(result.backupPath, getOpenClawConfigBackupPath(configPath));
    assert.deepEqual(readJson(result.backupPath), oldConfig);
    verifyPrivatePath(configPath, { kind: "file" });
    verifyPrivatePath(result.backupPath, { kind: "file" });
    assertNoTempFiles(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw config replacement rejects a symlink without touching its target", async () => {
  const root = tempRoot("clawlore-auth-config-symlink-");
  const configPath = join(root, "openclaw.json");
  const target = join(root, "target.json");
  try {
    writeFileSync(target, "target-canary\n", { mode: 0o600 });
    symlinkSync(target, configPath);
    await assert.rejects(
      saveOpenClawConfig(configPath, legacyConfig()),
      /CLAWLORE_PRIVATE_(?:PATH_SYMLINK_REJECTED|FILE_KIND_INVALID)/,
    );
    assert.equal(readFileSync(target, "utf8"), "target-canary\n");
    assert.equal(existsSync(getOpenClawConfigBackupPath(configPath)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [faultPoint, expectedMode] of [
  ["beforeTempSync", "oauth"],
  ["afterTempSync", "oauth"],
  ["beforeRename", "oauth"],
  ["afterRename", "api-key"],
  ["beforeDirectorySync", "api-key"],
  ["beforePostRenameValidation", "api-key"],
  ["beforeOauthDelete", "api-key"],
  ["afterOauthDelete", "api-key"],
  ["beforeBackupDelete", "api-key"],
  ["afterBackupDelete", "api-key"],
]) {
  test(`logout fault at ${faultPoint} preserves a parseable config and at least one auth mode`, async () => {
    const fixture = await createLogoutFixture(`clawlore-auth-fault-${faultPoint}-`);
    try {
      const configWritePoints = new Set([
        "beforeTempSync",
        "afterTempSync",
        "beforeRename",
        "afterRename",
        "beforeDirectorySync",
        "beforePostRenameValidation",
      ]);
      const hooks = configWritePoints.has(faultPoint)
        ? { configWrite: { [faultPoint]: () => { throw new Error(`fixture_${faultPoint}`); } } }
        : { [faultPoint]: () => { throw new Error(`fixture_${faultPoint}`); } };
      await assert.rejects(
        performOAuthLogoutConfigTransaction({
          configPath: fixture.configPath,
          pluginId: "clawlore",
          hooks,
        }),
        new RegExp(`fixture_${faultPoint}`),
      );
      assert.equal(assertAtLeastOneAuthMode(fixture.configPath, fixture.oauthPath), expectedMode);
      assert.doesNotThrow(() => JSON.parse(readFileSync(fixture.configPath, "utf8")));
      assertNoTempFiles(fixture.root);
      if (faultPoint === "afterOauthDelete" || faultPoint === "beforeBackupDelete") {
        assert.equal(existsSync(fixture.oauthPath), false);
        assert.equal(existsSync(getOauthBackupPath(fixture.oauthPath)), true);
      }
      if (faultPoint === "afterBackupDelete") {
        assert.equal(existsSync(fixture.oauthPath), false);
        assert.equal(existsSync(getOauthBackupPath(fixture.oauthPath)), false);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("successful logout restores the exact SecretRef config before deleting OAuth authorities", async () => {
  const fixture = await createLogoutFixture();
  try {
    const result = await performOAuthLogoutConfigTransaction({
      configPath: fixture.configPath,
      pluginId: "clawlore",
    });
    const config = readJson(fixture.configPath);
    assert.deepEqual(config.plugins.entries.clawlore.config.llm, fixture.originalApiKeyLlm);
    assert.equal(existsSync(fixture.oauthPath), false);
    assert.equal(existsSync(getOauthBackupPath(fixture.oauthPath)), false);
    assert.equal(result.previousAuth, "oauth");
    assert.deepEqual(readJson(result.configBackupPath), oauthConfig(fixture.oauthPath));
    assertNoTempFiles(fixture.root);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("logout restores an intentionally absent prior llm config", async () => {
  const root = tempRoot("clawlore-auth-no-llm-");
  const configPath = join(root, "openclaw.json");
  const oauthPath = join(root, ".clawlore", "oauth.json");
  try {
    await writePrivateJson(configPath, oauthConfig(oauthPath));
    await writePrivateFileAtomic(oauthPath, json({ access_token: "fixture-oauth-authority" }));
    await saveOauthLlmBackup(oauthPath, undefined, false);
    await performOAuthLogoutConfigTransaction({ configPath, pluginId: "clawlore" });
    assert.equal(Object.hasOwn(readJson(configPath).plugins.entries.clawlore.config, "llm"), false);
    assert.equal(existsSync(oauthPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const backupState of ["missing", "corrupt", "legacy-v1", "unexpected-field"]) {
  test(`logout fails closed with ${backupState} backup and preserves OAuth`, async () => {
    const root = tempRoot(`clawlore-auth-backup-${backupState}-`);
    const configPath = join(root, "openclaw.json");
    const oauthPath = join(root, ".clawlore", "oauth.json");
    try {
      await writePrivateJson(configPath, oauthConfig(oauthPath));
      await writePrivateFileAtomic(oauthPath, json({ access_token: "fixture-oauth-authority" }));
      if (backupState === "corrupt") {
        await writePrivateFileAtomic(getOauthBackupPath(oauthPath), "not-json\n");
      } else if (backupState === "legacy-v1") {
        await writePrivateJson(getOauthBackupPath(oauthPath), {
          version: 1,
          hadLlmConfig: true,
          llm: { auth: "api-key", model: "lossy-old-backup" },
        });
      } else if (backupState === "unexpected-field") {
        await writePrivateJson(getOauthBackupPath(oauthPath), {
          version: 2,
          hadLlmConfig: true,
          llm: { auth: "api-key", apiKey: secretRef },
          ignored: true,
        });
      }
      await assert.rejects(
        performOAuthLogoutConfigTransaction({ configPath, pluginId: "clawlore" }),
        /CLAWLORE_OAUTH_(?:LOGOUT_BACKUP_REQUIRED|LLM_BACKUP_INVALID)/,
      );
      assert.equal(assertAtLeastOneAuthMode(configPath, oauthPath), "oauth");
      assert.equal(existsSync(getOpenClawConfigBackupPath(configPath)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
