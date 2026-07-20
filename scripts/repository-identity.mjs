function repositoryUrl(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.url === "string") return value.url;
  throw new Error("release gate failed: package repository URL is missing or invalid");
}

export function canonicalRepositoryIdentity(value) {
  let raw = repositoryUrl(value).trim().replace(/^git\+/, "");
  const scpLike = raw.match(/^[^@/:]+@([^:]+):(.+)$/);
  if (scpLike) raw = `ssh://${scpLike[1]}/${scpLike[2]}`;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("release gate failed: repository URL must be an absolute network Git URL");
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
    throw new Error("release gate failed: repository URL must use a network Git transport");
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (!host || !path || !path.includes("/")) {
    throw new Error("release gate failed: repository URL must identify an owner and repository");
  }
  return `${host}/${path}`;
}

export function assertRepositoryIdentity({ declaredRepository, originUrl }) {
  const declared = canonicalRepositoryIdentity(declaredRepository);
  const origin = canonicalRepositoryIdentity(originUrl);
  if (declared !== origin) {
    throw new Error(
      `release gate failed: package repository and origin disagree (package=${declared}, origin=${origin})`,
    );
  }
  return declared;
}

export function assertReachableRemoteHead({ identity, status, stdout }) {
  const head = String(stdout || "").trim().split(/\s+/)[0] || "";
  if (status !== 0 || !/^[0-9a-f]{40,64}$/i.test(head)) {
    throw new Error(`release gate failed: canonical repository is not reachable at ${identity}`);
  }
  return head.toLowerCase();
}

export function assertRemoteReleaseCommit({ identity, status, stdout, localHead, targetRef }) {
  const expected = String(localHead || "").trim().toLowerCase();
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const refs = lines.map((line) => line.trim().split(/\s+/));
  const direct = refs
    .find(([, ref]) => ref === targetRef);
  const peeled = refs.find(([, ref]) => ref === `${targetRef}^{}`);
  const match = peeled ?? direct;
  if (status !== 0 || !direct || !match || !/^[0-9a-f]{40,64}$/i.test(match[0])) {
    throw new Error(`release gate failed: target remote ref ${targetRef} is not reachable at ${identity}`);
  }
  if (!/^[0-9a-f]{40,64}$/i.test(expected) || match[0].toLowerCase() !== expected) {
    throw new Error(`release gate failed: local release commit is not published at origin ${targetRef}`);
  }
  return expected;
}
