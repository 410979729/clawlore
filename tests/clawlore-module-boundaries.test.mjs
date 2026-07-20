import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";

const sourceRoot = resolve("src/v2");
const canonicalRoot = resolve("src");

const allowed = {
  domain: new Set(["domain"]),
  application: new Set(["application", "domain"]),
  storage: new Set(["storage", "application", "domain"]),
  workers: new Set(["workers", "application", "domain"]),
  adapters: new Set(["adapters", "application", "domain"]),
  migration: new Set(["migration", "application", "domain", "storage"]),
  operator: new Set(["operator", "application", "domain", "storage", "migration"]),
  eval: new Set(["eval", "application", "adapters", "domain"]),
};

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile() && path.endsWith(".ts")) result.push(path);
  }
  return result;
}

function importedSpecifiers(source) {
  const result = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) result.push(match[1]);
  return result;
}

test("V2 modules obey the declared inward dependency direction", async () => {
  const violations = [];
  for (const path of await files(sourceRoot)) {
    const from = relative(sourceRoot, path).split(sep)[0];
    assert.ok(allowed[from], `unclassified V2 module: ${from}`);
    const source = await readFile(path, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(path), specifier.replace(/\.js$/, ".ts"));
      const targetRelative = relative(sourceRoot, target);
      if (targetRelative.startsWith("..")) continue;
      const to = targetRelative.split(sep)[0];
      if (!allowed[from].has(to)) violations.push(`${relative(sourceRoot, path)} -> ${targetRelative}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("application services do not depend on concrete storage adapters", async () => {
  const violations = [];
  for (const path of await files(join(sourceRoot, "application"))) {
    const source = await readFile(path, "utf8");
    if (/\.\.\/storage\//.test(source)) violations.push(relative(sourceRoot, path));
  }
  assert.deepEqual(violations, []);
});

test("canonical application and OpenClaw adapters obey the active inward boundary", async () => {
  const activeRoots = [join(canonicalRoot, "application"), join(canonicalRoot, "adapters", "openclaw")];
  // Canonical V1 domain modules still live at src/ while the gradual
  // architecture migration is in progress. Keep this allowlist exact so an
  // application import cannot turn into an unrestricted root-module escape.
  const canonicalDomainModules = new Set([
    "memory-egress-policy.ts",
    "secret-redaction.ts",
    "secret-structured-text.ts",
  ]);
  const crossCuttingAdapterExceptions = new Set([
    "diagnostic-redaction.ts",
    "file-privacy.ts",
  ]);
  const violations = [];

  for (const root of activeRoots) {
    for (const path of await files(root)) {
      const fromApplication = path.startsWith(`${join(canonicalRoot, "application")}${sep}`);
      const source = await readFile(path, "utf8");
      for (const specifier of importedSpecifiers(source)) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(path), specifier.replace(/\.js$/, ".ts"));
        const targetRelative = relative(canonicalRoot, target).split(sep).join("/");
        const allowedTarget = targetRelative.startsWith("application/")
          || targetRelative.startsWith("v2/domain/")
          || canonicalDomainModules.has(targetRelative)
          || (!fromApplication && targetRelative.startsWith("adapters/openclaw/"))
          || (!fromApplication && crossCuttingAdapterExceptions.has(targetRelative));
        if (!allowedTarget) {
          violations.push(`${relative(canonicalRoot, path).split(sep).join("/")} -> ${targetRelative}`);
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});
