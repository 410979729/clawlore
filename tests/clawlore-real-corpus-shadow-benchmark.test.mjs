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
      {
        id: "relevant-release-context",
        text: "发布验收还应保留可追溯证据，并确认没有遗留临时产物。",
        category: "procedures",
        scope: "user:fixture",
        source_file: "source.md",
        source_anchor: "relevant release context",
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
      schemaVersion: 2,
      kind: "operator-annotated-real-corpus",
      name: "fixture-real-corpus",
      source_files: [{ path: "source.md", sha256: hash(source) }],
      thresholds: {
        recall_at_3: 0.9,
        mrr: 0.85,
        precision_at_3: 0.8,
        abstention_rate: 0.9,
        maximum_false_positive_results: 0,
        maximum_cross_scope_leakage: 0,
        maximum_unsafe_egress_violations: 0,
        maximum_forbidden_violations: 0,
      },
      retrieval: {
        manual_recall_min_score: 0.4,
        manual_recall_lexical_min_score: 0.05,
        manual_recall_vector_only_min_score: 0.65,
        manual_recall_minimum_top_gap: 0.05,
      },
      setup,
      cases: [
        ...Array.from({ length: 30 }, (_, index) => ({
        name: `release-verification-${index + 1}`,
        query: "发布前要做哪些测试构建和健康验证？",
        annotated: true,
        annotation: "The canonical rule is required; the release evidence rule is relevant support.",
        expected_ids: ["expected-release-rule"],
        relevant_ids: ["relevant-release-context"],
        forbidden_ids: ["decoy-other-scope"],
        scope_filter: ["user:fixture"],
        limit: 3,
        })),
        ...Array.from({ length: 10 }, (_, index) => ({
          name: `no-answer-${index + 1}`,
          query: `火星温室第 ${index + 1} 号的虚构紫色苔藓灌溉参数是什么？`,
          annotated: true,
          annotation: "No canonical source contains this fictional subject, so retrieval must abstain.",
          expect_empty: true,
          expected_ids: [],
          forbidden_ids: [],
          scope_filter: ["user:fixture"],
          limit: 3,
        })),
      ],
    };
    const fixturePath = join(root, "fixture.json");
    await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, { mode: 0o600 });
    await chmod(fixturePath, 0o600);

    const report = await evaluateRealCorpusShadow({ fixturePath, workspaceRoot: root });
    assert.equal(report.status, "pass", JSON.stringify({
      metrics: report.metrics,
      blockers: report.decision.blockers,
      positive: report.cases[0],
      negative: report.cases.at(-1),
    }));
    assert.equal(report.metrics.RecallAt3, 1);
    assert.equal(report.metrics.PrecisionAt3, 1);
    assert.equal(report.metrics.MRR, 1);
    assert.equal(report.metrics.abstentionRate, 1);
    assert.equal(report.metrics.falsePositiveResults, 0);
    assert.equal(report.metrics.crossScopeLeakage, 0);
    assert.equal(report.metrics.unsafeEgressViolations, 0);
    assert.equal(report.metrics.forbiddenViolations, 0);
    assert.equal(report.cases.length, 40);
    assert.equal(report.corpus.positiveCases, 30);
    assert.equal(report.corpus.negativeCases, 10);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("发布前要做哪些"), false);
    assert.equal(serialized.includes("expected-release-rule"), false);
    assert.equal(report.decision.authorizesAutomaticRecall, false);
    assert.equal(report.decision.liveProviderSemanticReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
