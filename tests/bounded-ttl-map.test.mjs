import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { BoundedTtlMap } = jiti("../src/bounded-ttl-map.ts");

test("bounded TTL map caps 10,000 principals and expires the retained LRU set", () => {
  let now = 1_000;
  const cache = new BoundedTtlMap({ ttlMs: 100, maxEntries: 64, now: () => now });
  for (let index = 0; index < 10_000; index += 1) cache.set(`principal-${index}`, index);

  assert.deepEqual(cache.stats(), {
    size: 64,
    ttlEvictions: 0,
    capacityEvictions: 9_936,
  });
  assert.equal(cache.get("principal-9999"), 9_999);
  assert.equal(cache.get("principal-0"), undefined);

  now += 101;
  assert.deepEqual(cache.stats(), {
    size: 0,
    ttlEvictions: 64,
    capacityEvictions: 9_936,
  });
});
