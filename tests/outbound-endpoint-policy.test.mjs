import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  assertOutboundEndpointAllowed,
  createSafeOutboundFetch,
  parseOutboundEndpointPolicy,
  validateOutboundEndpointSyntax,
} = jiti("../src/outbound-endpoint-policy.ts");

test("outbound endpoint policy rejects unsafe protocols, credentials, HTTP, and private literals", () => {
  const policy = parseOutboundEndpointPolicy(undefined);
  for (const endpoint of [
    "file:///etc/passwd",
    "gopher://127.0.0.1/",
    "https://user:password@example.com/v1",
    "http://api.example.com/v1",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.8/v1",
    "https://[::1]/v1",
  ]) {
    assert.throws(() => validateOutboundEndpointSyntax(endpoint, policy), /CLAWLORE_OUTBOUND_ENDPOINT_/u);
  }
  assert.equal(validateOutboundEndpointSyntax("https://8.8.8.8/v1", policy).hostname, "8.8.8.8");
});

test("private endpoints require an exact normalized operator allowlist entry", () => {
  const policy = parseOutboundEndpointPolicy({
    allowedPrivateHosts: ["LOCALHOST.", "127.0.0.1", "localhost"],
  });
  assert.deepEqual(policy.allowedPrivateHosts, ["127.0.0.1", "localhost"]);
  assert.equal(validateOutboundEndpointSyntax("http://localhost:11434/v1", policy).port, "11434");
  assert.equal(validateOutboundEndpointSyntax("http://127.0.0.1:11434/v1", policy).port, "11434");
  assert.throws(
    () => validateOutboundEndpointSyntax("http://ollama.internal:11434/v1", policy),
    /HTTPS_REQUIRED/u,
  );
  assert.throws(
    () => parseOutboundEndpointPolicy({ allowedPrivateHosts: ["*.internal"] }),
    /INVALID_HOST/u,
  );
});

test("DNS resolution fails closed for private or mixed answers", async () => {
  const policy = parseOutboundEndpointPolicy(undefined);
  await assert.rejects(
    () => assertOutboundEndpointAllowed(
      "https://provider.example/v1",
      policy,
      async () => [{ address: "169.254.169.254", family: 4 }],
    ),
    /PRIVATE_ADDRESS_BLOCKED/u,
  );
  await assert.rejects(
    () => assertOutboundEndpointAllowed(
      "https://provider.example/v1",
      policy,
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.4", family: 4 },
      ],
    ),
    /PRIVATE_ADDRESS_BLOCKED/u,
  );
  await assert.doesNotReject(
    () => assertOutboundEndpointAllowed(
      "https://provider.example/v1",
      policy,
      async () => [{ address: "8.8.8.8", family: 4 }],
    ),
  );
});

test("safe fetch disables redirect following after request-time DNS validation", async () => {
  let redirectMode;
  const safeFetch = createSafeOutboundFetch(parseOutboundEndpointPolicy(undefined), {
    resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response("", {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    },
  });
  await assert.rejects(
    () => safeFetch("https://provider.example/v1", { method: "POST" }),
    /REDIRECT_BLOCKED/u,
  );
  assert.equal(redirectMode, "manual");
});

test("safe fetch connects through the same validated DNS answer without a second lookup", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("pinned");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let resolutions = 0;
    const safeFetch = createSafeOutboundFetch(
      parseOutboundEndpointPolicy({ allowedPrivateHosts: ["pinned.test"] }),
      {
        resolveHost: async () => {
          resolutions += 1;
          return resolutions === 1
            ? [{ address: "127.0.0.1", family: 4 }]
            : [{ address: "169.254.169.254", family: 4 }];
        },
      },
    );
    const response = await safeFetch(`http://pinned.test:${address.port}/`);
    assert.equal(await response.text(), "pinned");
    assert.equal(resolutions, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("all configurable provider request paths use or require the shared endpoint policy", async () => {
  for (const path of ["../src/embedder.ts", "../src/llm-client.ts"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /createSafeOutboundFetch/u, path);
    assert.doesNotMatch(source, /\bawait\s+fetch\s*\(/u, path);
  }
  const retriever = await readFile(new URL("../src/retriever.ts", import.meta.url), "utf8");
  const composition = await readFile(new URL("../src/core-memory-runtime.ts", import.meta.url), "utf8");
  assert.match(retriever, /outboundFetch/u);
  assert.doesNotMatch(retriever, /\bawait\s+fetch\s*\(/u);
  assert.match(composition, /outboundFetch:\s*createSafeOutboundFetch/u);
});
