import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  saveOAuthSession,
} = jiti("../src/llm-oauth.ts");

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
