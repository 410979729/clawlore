import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { MemoryStore } = jiti("../src/store.ts");
const { assertMemoryEntrySafeForPersistence } = jiti("../src/memory-entry-write-policy.ts");

function entry(overrides = {}) {
  return {
    text: "Bounded verified memory",
    vector: [1, 0, 0, 0],
    category: "fact",
    scope: "agent:test",
    importance: 0.8,
    metadata: JSON.stringify({ state: "confirmed" }),
    ...overrides,
  };
}

test("runtime persistence policy validates shape and keeps safe secret-index references usable", () => {
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({
    text: '{"databasePassword":"synthetic-runtime-store-secret"}',
  })), /safety policy/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({
    metadata: JSON.stringify({ serviceToken: "synthetic-runtime-metadata-secret" }),
  })), /safety policy/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({
    metadata: JSON.stringify({ evidence: "[Image attached at: /tmp/clawlore-metadata-private.png]" }),
  })), /safety policy/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({
    metadata: JSON.stringify({ evidence: "OAuth file is /home/a/.openclaw/oauth/token-cache.json" }),
  })), /safety policy/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({
    metadata: JSON.stringify({ evidence: "OpenClaw runtime context for this turn: raw wrapper" }),
  })), /safety policy/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({ category: "credential" })), /category/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({ importance: Number.NaN })), /importance/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({ vector: [1, Number.NaN] })), /vector/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({ metadata: "not-json" })), /valid JSON/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({
    text: "Release evidence [Image attached at: /tmp/clawlore-direct-store-private.png]",
  })), /safety policy/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({
    text: "OAuth file is /home/a/.openclaw/oauth/token-cache.json",
  })), /safety policy/);
  assert.throws(() => assertMemoryEntrySafeForPersistence(entry({
    scope: "agent:invalid scope",
  })), /scope rejected/);

  assert.doesNotThrow(() => assertMemoryEntrySafeForPersistence(entry({
    text: [
      "Secret index: deployment credential",
      "Kind: token",
      "Vault ref: op://infra/deploy/password",
      "Plaintext secret value: [never accepted by ClawLore]",
    ].join("\n"),
    metadata: JSON.stringify({
      sensitivity: "secret-index",
      secret_storage: "external-vault-reference",
      secret_value_stored: false,
      secret_type: "token",
      vault_ref: "op://infra/deploy/password",
    }),
  })));
});

test("runtime persistence accepts canonical OpenClaw session identity metadata", () => {
  const runtimeSession = "agent:main:telegram:default:direct:8176453077";
  assert.doesNotThrow(() => assertMemoryEntrySafeForPersistence(entry({
    metadata: JSON.stringify({
      sessionKey: runtimeSession,
      session_key: runtimeSession,
      source_session: runtimeSession,
    }),
  })));
});

test("MemoryStore rejects direct secret bypasses before SQL truth mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawlore-store-policy-"));
  let store;
  try {
    store = new MemoryStore({ dbPath: root, vectorDim: 4, vectorBackend: "sqlite-bruteforce" });
    await assert.rejects(() => store.store(entry({
      text: "Authorization: Digest synthetic-direct-store-secret-material",
    })), /safety policy/);
    const db = await store.getSqlTruthDb();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_truth").get().n, 0);

    const stored = await store.store(entry());
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_truth").get().n, 1);
    await assert.rejects(() => store.update(stored.id, {
      metadata: JSON.stringify({ databasePassword: "synthetic-update-secret" }),
    }, ["agent:test"]), /safety policy/);
    assert.equal((await store.getById(stored.id, ["agent:test"])).metadata, stored.metadata);

    await assert.rejects(() => store.importEntry({
      ...entry(),
      id: "90000000-0000-4000-8000-000000000099",
      timestamp: 1,
      text: "serviceToken: synthetic-import-secret",
    }), /safety policy/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_truth").get().n, 1);

    await assert.rejects(() => store.store(entry({
      text: "Keep release evidence. [Image attached at: /tmp/clawlore-store-bypass.png]",
    })), /safety policy/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_truth").get().n, 1);
  } finally {
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
