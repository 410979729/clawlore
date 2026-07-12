import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const { DatabaseSync } = require("node:sqlite");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createLiveCandidateEvidenceRemediationPlanV1 } =
  jiti("../src/v2/operator/live-candidate-evidence-remediation.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawlore-evidence-remediation-"));
  const source = join(root, "live.sqlite3");
  const registry = join(root, "sessions.json");
  const baseline = join(root, "baseline.json");
  const direct = "agent:main:telegram:default:direct:user-1";
  const group = "agent:main:telegram:group:group-1";
  const rows = [
    ["direct", { source: "auto-capture", sessionKey: direct }, "auto_capture"],
    ["group", { source: "auto-capture", sessionKey: group }, "auto_capture"],
    ["manual", { source: "manual", private_note: "do-not-emit-marker" }, "explicit_manual"],
    ["system", { source: "reflection-summary", source_session: "batch-1" }, "reflection_summary"],
    ["alias", { source: "auto-capture", source_session: "agent:main:main" }, "auto_capture"],
    ["opaque", { source: "auto-capture", source_session: "opaque" }, "auto_capture"],
    ["unknown", {}, "unknown_legacy"],
  ];
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE memory_truth(id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
    CREATE TABLE memory_items(item_id TEXT PRIMARY KEY,current_revision_id TEXT NOT NULL,lifecycle TEXT NOT NULL,verification TEXT NOT NULL);
    CREATE TABLE memory_sources(source_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE TABLE projection_outbox(outbox_id TEXT PRIMARY KEY,processed_at TEXT);`);
  for (const [id, metadata, classification] of rows) {
    db.prepare("INSERT INTO memory_truth VALUES (?,?)").run(id, JSON.stringify(metadata));
    db.prepare("INSERT INTO memory_items VALUES (?,?,?,?)").run(`legacy:${id}`, `revision:${id}`, "candidate", "unverified");
    db.prepare("INSERT INTO memory_sources VALUES (?,?,?)")
      .run(`source:${id}`, `revision:${id}`, JSON.stringify({ classification }));
  }
  db.close();
  await chmod(source, 0o600);
  await writeFile(registry, JSON.stringify({
    [direct]: { sessionId: "direct-id", sessionFile: join(root, "direct-id.jsonl") },
    [group]: { sessionId: "group-id", sessionFile: join(root, "group-id.jsonl") },
  }), { mode: 0o600 });
  const baselineRows = rows.map(([id]) => ({ itemIdSha256: sha256(`legacy:${id}`) }));
  await writeFile(baseline, JSON.stringify({
    phase: "clawlore-phase7g-live-preview",
    candidatePromotionPlan: {
      planDigest: sha256("baseline"),
      rows: baselineRows,
      authorizesLiveMutation: false,
    },
  }), { mode: 0o600 });
  return { root, source, registry, baseline };
}

test("candidate evidence remediation creates a redacted query-only workbench", async () => {
  const paths = await fixture();
  try {
    const plan = createLiveCandidateEvidenceRemediationPlanV1({
      sourcePath: paths.source,
      sessionsRegistryPath: paths.registry,
      baselinePreviewPath: paths.baseline,
    });
    assert.equal(plan.source.candidateRows, 7);
    assert.equal(plan.counts.registry_private_assignment_review, 1);
    assert.equal(plan.counts.registry_conversation_assignment_review, 1);
    assert.equal(plan.counts.manual_principal_assignment_review, 1);
    assert.equal(plan.counts.derived_system_evidence_review, 1);
    assert.equal(plan.counts.legacy_agent_alias_quarantine, 1);
    assert.equal(plan.counts.opaque_reference_quarantine, 1);
    assert.equal(plan.counts.unknown_legacy_quarantine, 1);
    assert.deepEqual(plan.summary, {
      assignmentReviewRows: 3,
      evidenceReviewRows: 1,
      quarantineRows: 3,
      mutationReadyRows: 0,
    });
    assert.equal(plan.authorizesLifecycleMutation, false);
    assert.equal(plan.automaticPromotionRows, 0);
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes("user-1"), false);
    assert.equal(serialized.includes("group-1"), false);
    assert.equal(serialized.includes("legacy:direct"), false);
    assert.equal(serialized.includes("do-not-emit-marker"), false);
    assert.equal(serialized.includes("auto-capture"), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("candidate evidence remediation fails closed when the baseline candidate set is stale", async () => {
  const paths = await fixture();
  try {
    const baseline = JSON.parse(await (await import("node:fs/promises")).readFile(paths.baseline, "utf8"));
    baseline.candidatePromotionPlan.rows.pop();
    await writeFile(paths.baseline, JSON.stringify(baseline), { mode: 0o600 });
    assert.throws(() => createLiveCandidateEvidenceRemediationPlanV1({
      sourcePath: paths.source,
      sessionsRegistryPath: paths.registry,
      baselinePreviewPath: paths.baseline,
    }), /no longer matches baseline/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
