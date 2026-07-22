import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateRealCorpusShadow } from "../scripts/clawlore-real-corpus-shadow-benchmark.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("real-corpus shadow benchmark is source-bound, content-free, and enforces Recall@3", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlore-real-corpus-test-"));
  try {
    const source = Buffer.from("canonical release verification rule\n", "utf8");
    await writeFile(join(root, "source.md"), source, { mode: 0o600 });
    const setup = [
      {
        id: "expected-release-rule",
        text: "发布完成前必须执行测试、构建与健康验证。",
        category: "procedures",
        scope: "user:fixture",
        source_file: "source.md",
        source_anchor: "release verification",
      },
      {
        id: "decoy-other-scope",
        text: "发布完成前必须执行测试、构建与健康验证。",
        category: "procedures",
        scope: "user:other",
        source_file: "source.md",
        source_anchor: "scope isolation decoy",
      },
    ];
    for (let index = 0; index < 8; index += 1) {
      setup.push({
        id: `safe-filler-${index}`,
        text: `第 ${index + 1} 条独立维护规则用于真实语料评估。`,
        category: "facts",
        scope: "user:fixture",
        source_file: "source.md",
        source_anchor: `filler ${index + 1}`,
      });
    }
    const fixture = {
      schemaVersion: 1,
      kind: "operator-annotated-real-corpus",
      name: "fixture-real-corpus",
      source_files: [{ path: "source.md", sha256: hash(source) }],
      thresholds: {
        recall_at_3: 0.9,
        mrr: 0.85,
        maximum_cross_scope_leakage: 0,
        maximum_unsafe_egress_violations: 0,
        maximum_forbidden_violations: 0,
      },
      setup,
      cases: Array.from({ length: 30 }, (_, index) => ({
        name: `release-verification-${index + 1}`,
        query: "发布前要做哪些测试构建和健康验证？",
        annotated: true,
        annotation: "The canonical release verification rule is the only relevant result.",
        expected_ids: ["expected-release-rule"],
        forbidden_ids: ["decoy-other-scope"],
        scope_filter: ["user:fixture"],
        limit: 3,
      })),
    };
    const fixturePath = join(root, "fixture.json");
    await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, { mode: 0o600 });
    await chmod(fixturePath, 0o600);

    const report = await evaluateRealCorpusShadow({ fixturePath, workspaceRoot: root });
    assert.equal(report.status, "pass");
    assert.equal(report.metrics.RecallAt3, 1);
    assert.equal(report.metrics.MRR, 1);
    assert.equal(report.metrics.crossScopeLeakage, 0);
    assert.equal(report.metrics.unsafeEgressViolations, 0);
    assert.equal(report.metrics.forbiddenViolations, 0);
    assert.equal(report.cases.length, 30);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("发布前要做哪些"), false);
    assert.equal(serialized.includes("expected-release-rule"), false);
    assert.equal(report.decision.authorizesAutomaticRecall, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

