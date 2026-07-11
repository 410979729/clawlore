/**
 * Reviewed outbound bridge from Experience playbooks to human truth.
 *
 * Generates draft candidates and optional draft ledger rows. It never writes
 * Markdown truth and never applies Skill Workshop proposals by itself.
 */
import { randomUUID } from "node:crypto";
function clampLimit(value, fallback = 20) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    const n = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(1, Math.min(Math.trunc(n), 200));
}
function safeJson(value, fallback) {
    if (typeof value !== "string" || !value.trim())
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
function slugify(value) {
    const tokens = value
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}._-]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return tokens || "experience-draft";
}
function hasRiskyCapability(steps) {
    return steps.some((step) => {
        const capability = String(step.capability_class ?? "");
        return [
            "service_control",
            "network_or_remote",
            "cross_instance",
            "credential_adjacent",
            "destructive_or_irreversible",
        ].includes(capability);
    });
}
function coveredPaths(playbook, docs) {
    const title = normalizeText(playbook.title);
    const taskClass = normalizeText(playbook.task_class);
    const trigger = normalizeText(playbook.trigger);
    const needles = [title, taskClass, trigger]
        .filter((item) => item.length >= 8)
        .slice(0, 3);
    if (needles.length === 0)
        return [];
    return docs
        .filter((doc) => {
        const haystack = normalizeText(`${doc.title ?? ""}\n${doc.text ?? ""}\n${doc.path}`);
        return needles.some((needle) => haystack.includes(needle));
    })
        .map((doc) => doc.path)
        .slice(0, 8);
}
export function ensureKnowledgeSkillBridgeSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_skill_promotion_drafts (
      id TEXT PRIMARY KEY,
      playbook_id TEXT NOT NULL,
      source_episode_id TEXT NOT NULL DEFAULT '',
      target_kind TEXT NOT NULL,
      title TEXT NOT NULL,
      task_class TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      dedupe_state TEXT NOT NULL,
      related_paths TEXT NOT NULL DEFAULT '[]',
      draft_path_hint TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_skill_drafts_playbook
      ON knowledge_skill_promotion_drafts(playbook_id);

    CREATE INDEX IF NOT EXISTS idx_knowledge_skill_drafts_target
      ON knowledge_skill_promotion_drafts(target_kind);
  `);
}
export function buildKnowledgeSkillDrafts(db, options = {}) {
    const limit = clampLimit(options.limit);
    const statusFilter = "status IN ('promoted', 'reviewed', 'needs_review')";
    const scopeWhere = options.scope_id ? "AND (scope_id = ? OR shared_scope_id = ?)" : "";
    const params = options.scope_id ? [options.scope_id, options.scope_id, limit] : [limit];
    const rows = db.prepare(`
    SELECT *
    FROM procedural_playbooks
    WHERE ${statusFilter}
    ${scopeWhere}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params);
    const target = options.target ?? "both";
    const drafts = [];
    for (const row of rows) {
        const steps = safeJson(row.steps, []);
        const related = coveredPaths(row, options.existing_docs ?? []);
        const risky = hasRiskyCapability(steps);
        const preferredTarget = related.length > 0
            ? "already_covered"
            : risky
                ? "skill"
                : "knowledge";
        if (target !== "both" && preferredTarget !== "already_covered" && preferredTarget !== target) {
            continue;
        }
        const title = String(row.title ?? "").trim() || "Experience promotion draft";
        const taskClass = String(row.task_class ?? "").trim();
        const draftPathHint = preferredTarget === "skill"
            ? `Skill Workshop proposal: ${slugify(title)}`
            : preferredTarget === "knowledge"
                ? `knowledge/ops/${slugify(title)}.md`
                : related[0] ?? "";
        const sourceEpisodeId = String(row.created_from_episode_id ?? "");
        drafts.push({
            id: randomUUID(),
            playbook_id: String(row.id ?? ""),
            source_episode_id: sourceEpisodeId,
            target_kind: preferredTarget,
            title,
            task_class: taskClass,
            status: options.record ? "recorded" : "draft",
            dedupe_state: related.length > 0 ? "covered" : "new",
            related_paths: related,
            draft_path_hint: draftPathHint,
            summary: [
                `Trigger: ${String(row.trigger ?? "").slice(0, 220)}`,
                `Goal: ${String(row.goal ?? "").slice(0, 220)}`,
                `Verification: ${safeJson(row.verification, []).slice(0, 3).join("; ")}`,
            ].join("\n"),
            audit: {
                source_playbook_id: String(row.id ?? ""),
                source_episode_id: sourceEpisodeId,
                final_artifact: draftPathHint,
            },
        });
    }
    if (options.record && drafts.length > 0) {
        ensureKnowledgeSkillBridgeSchema(db);
        const now = new Date().toISOString();
        const insert = db.prepare(`
      INSERT INTO knowledge_skill_promotion_drafts (
        id, playbook_id, source_episode_id, target_kind, title, task_class,
        status, dedupe_state, related_paths, draft_path_hint, summary, created_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        for (const draft of drafts) {
            insert.run(draft.id, draft.playbook_id, draft.source_episode_id, draft.target_kind, draft.title, draft.task_class, draft.status, draft.dedupe_state, JSON.stringify(draft.related_paths), draft.draft_path_hint, draft.summary, now, JSON.stringify({ audit: draft.audit, source: "knowledge_skill_bridge" }));
        }
    }
    return {
        dry_run: options.record !== true,
        recorded: options.record === true,
        count: drafts.length,
        drafts,
    };
}
