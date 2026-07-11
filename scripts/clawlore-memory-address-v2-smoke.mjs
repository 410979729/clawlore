import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { resolveMemoryIdentity } = jiti("../src/v2/application/identity-resolver.ts");
const { mapLegacyAddress } = jiti("../src/v2/migration/legacy-address-mapper.ts");

const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/clawlore-memory-address-v2.json", import.meta.url), "utf8"));
const identity = fixture.identityCases.map((item) => ({
  name: item.name,
  result: resolveMemoryIdentity(item.input),
}));
const legacy = fixture.legacyCases.map((item) => ({
  name: item.name,
  result: mapLegacyAddress(item.input, { tenantId: "local", agentId: "main", workspaceId: "workspace-main" }),
}));
const failed = identity.filter((item) => item.result.status === "unresolved" && item.result.durableWriteAllowed).length;

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  status: failed === 0 ? "PASS" : "FAIL",
  identityCases: identity.length,
  legacyCases: legacy.length,
  unsafeUnresolvedWrites: failed,
  reviewRequiredLegacyRows: legacy.filter((item) => item.result.reviewRequired).length,
  identity,
  legacy,
}, null, 2)}\n`);

if (failed > 0) process.exitCode = 1;
