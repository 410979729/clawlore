import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import {
  cleanupPrivateTemporaryEnvironment,
  createPrivateTemporaryEnvironment,
  privateTemporaryParent,
} from "../scripts/private-temporary-environment.mjs";

test("Windows release and test runners use an isolated user-profile temp root", () => {
  const created = [];
  const temporary = createPrivateTemporaryEnvironment({
    platform: "win32",
    home: "C:\\Users\\fixture",
    prefix: ".clawlore-release-gate-",
    baseEnv: { KEEP: "yes", TEMP: "C:\\shared", TMP: "C:\\shared" },
    create: (prefix) => {
      created.push(prefix);
      return `${prefix}123`;
    },
  });
  assert.deepEqual(created, [
    join("C:\\Users\\fixture", ".clawlore-release-gate-"),
  ]);
  assert.equal(temporary.env.KEEP, "yes");
  assert.equal(temporary.env.TEMP, temporary.root);
  assert.equal(temporary.env.TMP, temporary.root);
  assert.equal(temporary.env.CLAWLORE_PRIVATE_TEMP_ROOT, temporary.root);
});

test("non-Windows runners preserve the existing temp environment", () => {
  const temporary = createPrivateTemporaryEnvironment({
    platform: "linux",
    baseEnv: { TEMP: "/tmp/example", KEEP: "yes" },
    create: () => {
      throw new Error("must not create a private root");
    },
  });
  assert.equal(temporary.root, undefined);
  assert.deepEqual(temporary.env, { TEMP: "/tmp/example", KEEP: "yes" });
});

test("standalone Windows scripts prefer a declared private root, then the profile", () => {
  assert.equal(
    privateTemporaryParent({
      platform: "win32",
      env: { CLAWLORE_PRIVATE_TEMP_ROOT: "C:\\private-run" },
      home: "C:\\Users\\fixture",
    }),
    "C:\\private-run",
  );
  assert.equal(
    privateTemporaryParent({
      platform: "win32",
      env: {},
      home: "C:\\Users\\fixture",
    }),
    "C:\\Users\\fixture",
  );
});

test("private temp cleanup is exact and recursive", () => {
  const calls = [];
  cleanupPrivateTemporaryEnvironment("C:\\Users\\fixture\\.clawlore-run-123", {
    remove: (path, options) => calls.push({ path, options }),
  });
  assert.deepEqual(calls, [{
    path: "C:\\Users\\fixture\\.clawlore-run-123",
    options: {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    },
  }]);
});
