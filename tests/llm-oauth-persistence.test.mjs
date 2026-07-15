import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  buildOAuthErrorHtml,
  evaluateOAuthCallback,
  loadOAuthSession,
  performOAuthLogin,
  saveOAuthSession,
} = jiti("../src/llm-oauth.ts");
const { readOAuthSessionFile } = jiti("../src/oauth-session-storage.ts");

function session(accessToken = "fixture-access", refreshToken = "fixture-refresh") {
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 60_000,
    accountId: "fixture-account",
    providerId: "openai-codex",
    authPath: "",
  };
}

test("OAuth session replacement is atomic and hardens an existing 0644 file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-oauth-private-"));
  const authPath = join(dir, "oauth.json");
  try {
    writeFileSync(authPath, "legacy-wide-file\n", { mode: 0o644 });
    chmodSync(authPath, 0o644);
    await saveOAuthSession(authPath, session());
    assert.equal(lstatSync(authPath).mode & 0o777, 0o600);
    const stored = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(stored.access_token, "fixture-access");
    assert.equal(stored.refresh_token, "fixture-refresh");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth session replacement rejects symlinks without touching their target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-oauth-symlink-"));
  const target = join(dir, "target.json");
  const authPath = join(dir, "oauth.json");
  try {
    writeFileSync(target, "do-not-touch\n", { mode: 0o600 });
    symlinkSync(target, authPath);
    await assert.rejects(saveOAuthSession(authPath, session()), /CLAWLORE_OAUTH_UNSAFE_AUTH_PATH/);
    assert.equal(readFileSync(target, "utf8"), "do-not-touch\n");
    assert.equal(lstatSync(authPath).isSymbolicLink(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth session load hardens an existing 0644 file and private parent before reading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-oauth-load-private-"));
  const authPath = join(dir, "oauth.json");
  try {
    chmodSync(dir, 0o755);
    writeFileSync(authPath, JSON.stringify({
      provider: "openai-codex",
      access_token: "fixture-load-access",
      refresh_token: "fixture-load-refresh",
      account_id: "fixture-load-account",
    }), { mode: 0o644 });
    chmodSync(authPath, 0o644);
    const loaded = await loadOAuthSession(authPath);
    assert.equal(loaded.accountId, "fixture-load-account");
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    assert.equal(lstatSync(authPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth session load rejects symbolic links without reading their target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-oauth-load-symlink-"));
  const target = join(dir, "target.json");
  const authPath = join(dir, "oauth.json");
  try {
    writeFileSync(target, JSON.stringify({
      provider: "openai-codex",
      access_token: "do-not-load",
      account_id: "target-account",
    }), { mode: 0o600 });
    symlinkSync(target, authPath);
    await assert.rejects(loadOAuthSession(authPath), (error) => {
      assert.match(error.message, /CLAWLORE_OAUTH_SESSION_READ_FAILED/);
      assert.doesNotMatch(error.message, new RegExp(authPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(error.message, /access-canary/);
      return true;
    });
    assert.equal(lstatSync(authPath).isSymbolicLink(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth secure read detects a regular-file identity swap before open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-oauth-load-swap-"));
  const authPath = join(dir, "oauth.json");
  const replacement = join(dir, "replacement.json");
  try {
    writeFileSync(authPath, "old-authority\n", { mode: 0o600 });
    writeFileSync(replacement, "replacement-authority\n", { mode: 0o600 });
    await assert.rejects(
      readOAuthSessionFile(authPath, {
        beforeOpen() { renameSync(replacement, authPath); },
      }),
      /CLAWLORE_OAUTH_FILE_IDENTITY_CHANGED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth failure before rename preserves the old file and cleans the temporary file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-oauth-prerename-"));
  const authPath = join(dir, "oauth.json");
  try {
    writeFileSync(authPath, "old-complete-value\n", { mode: 0o600 });
    await assert.rejects(
      saveOAuthSession(authPath, session(), {
        beforeRename() { throw new Error("fixture_before_rename_failure"); },
      }),
      /fixture_before_rename_failure/,
    );
    assert.equal(readFileSync(authPath, "utf8"), "old-complete-value\n");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth failure after rename leaves a complete private replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-oauth-postrename-"));
  const authPath = join(dir, "oauth.json");
  try {
    await assert.rejects(
      saveOAuthSession(authPath, session("post-rename-access"), {
        beforeDirectorySync() { throw new Error("fixture_directory_sync_failure"); },
      }),
      /fixture_directory_sync_failure/,
    );
    assert.equal(existsSync(authPath), true);
    assert.equal(lstatSync(authPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(authPath, "utf8")).access_token, "post-rename-access");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent OAuth refreshes never leave partial JSON or temporary files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-oauth-concurrent-"));
  const authPath = join(dir, "oauth.json");
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => saveOAuthSession(authPath, session(`access-${index}`))),
    );
    const stored = JSON.parse(readFileSync(authPath, "utf8"));
    assert.match(stored.access_token, /^access-\d+$/);
    assert.equal(lstatSync(authPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth callback validates state before provider error and escapes HTML", () => {
  const expected = "expected-state";
  assert.deepEqual(
    evaluateOAuthCallback(new URL("http://localhost/callback?state=wrong&error=%3Cscript%3Eboom%3C/script%3E"), expected),
    { kind: "invalid" },
  );
  assert.deepEqual(
    evaluateOAuthCallback(new URL(`http://localhost/callback?state=${expected}&error=access_denied`), expected),
    { kind: "provider_error" },
  );
  assert.deepEqual(
    evaluateOAuthCallback(new URL(`http://localhost/callback?state=${expected}&code=fixture-code`), expected),
    { kind: "success", code: "fixture-code" },
  );
  const html = buildOAuthErrorHtml('<script>alert("x")</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("OAuth callback listener is ready before an immediate browser callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clawlore-oauth-listener-ready-"));
  const authPath = join(dir, "oauth.json");
  const originalFetch = globalThis.fetch;
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "listener-account" },
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      access_token: `fixture.${payload}.signature`,
      refresh_token: "listener-refresh",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await performOAuthLogin({
      authPath,
      timeoutMs: 5_000,
      onOpenUrl: async (authorizeUrl) => {
        const state = new URL(authorizeUrl).searchParams.get("state");
        await new Promise((resolve, reject) => {
          const request = httpGet(
            `http://localhost:1455/auth/callback?state=${encodeURIComponent(state)}&code=fixture-code`,
            (response) => {
              response.resume();
              response.on("end", resolve);
            },
          );
          request.on("error", reject);
        });
      },
    });
    assert.equal(result.session.accountId, "listener-account");
    assert.equal(lstatSync(authPath).mode & 0o777, 0o600);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
