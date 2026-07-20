import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReachableRemoteHead,
  assertRemoteReleaseCommit,
  assertRepositoryIdentity,
  canonicalRepositoryIdentity,
} from "../scripts/repository-identity.mjs";

test("repository identity normalizes supported Git transports without exposing credentials", () => {
  assert.equal(
    canonicalRepositoryIdentity("git+https://github.com/410979729/ClawLore.git"),
    "github.com/410979729/clawlore",
  );
  assert.equal(
    canonicalRepositoryIdentity("git@github.com:410979729/clawlore.git"),
    "github.com/410979729/clawlore",
  );
  assert.equal(
    canonicalRepositoryIdentity("ssh://git@github.com/410979729/clawlore"),
    "github.com/410979729/clawlore",
  );
});

test("release publication requires local HEAD at the exact target remote ref", () => {
  const targetRef = "refs/heads/main";
  const localHead = "b".repeat(40);
  assert.equal(
    assertRemoteReleaseCommit({
      identity: "github.com/410979729/clawlore",
      status: 0,
      stdout: `${localHead}\t${targetRef}\n`,
      localHead,
      targetRef,
    }),
    localHead,
  );
  assert.throws(
    () => assertRemoteReleaseCommit({
      identity: "github.com/410979729/clawlore",
      status: 0,
      stdout: `${"a".repeat(40)}\t${targetRef}\n`,
      localHead,
      targetRef,
    }),
    /local release commit is not published at origin refs\/heads\/main/,
  );

  const tagRef = "refs/tags/v1.2.0";
  assert.equal(
    assertRemoteReleaseCommit({
      identity: "github.com/410979729/clawlore",
      status: 0,
      stdout: `${"c".repeat(40)}\t${tagRef}\n${localHead}\t${tagRef}^{}\n`,
      localHead,
      targetRef: tagRef,
    }),
    localHead,
  );
});

test("repository identity rejects an origin that still names the legacy repository", () => {
  assert.throws(
    () => assertRepositoryIdentity({
      declaredRepository: { url: "git+https://github.com/410979729/clawlore.git" },
      originUrl: "https://github.com/410979729/scope-recall-openclaw.git",
    }),
    /package=github\.com\/410979729\/clawlore, origin=github\.com\/410979729\/scope-recall-openclaw/,
  );
});

test("release publication requires a reachable canonical HEAD", () => {
  assert.equal(
    assertReachableRemoteHead({
      identity: "github.com/410979729/clawlore",
      status: 0,
      stdout: `${"a".repeat(40)}\tHEAD\n`,
    }),
    "a".repeat(40),
  );
  assert.throws(
    () => assertReachableRemoteHead({
      identity: "github.com/410979729/clawlore",
      status: 128,
      stdout: "",
    }),
    /canonical repository is not reachable/,
  );
});
