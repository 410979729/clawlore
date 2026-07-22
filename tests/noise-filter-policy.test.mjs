import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { isNoise } = jiti("../src/noise-filter.ts");

test("noise filter keeps durable post-operation rules", () => {
  assert.equal(
    isNoise("修复运维故障后要验证服务，并在当天日记记录故障和修复。"),
    false,
  );
  assert.equal(
    isNoise("检查配置后必须验证服务健康，失败时不得保存。"),
    false,
  );
});

test("noise filter still removes one-off user operation requests", () => {
  assert.equal(isNoise("修复数据库并检查服务"), true);
  assert.equal(isNoise("直接检查插件然后收口"), true);
});
