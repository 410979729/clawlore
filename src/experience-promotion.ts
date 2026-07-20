/**
 * Experience Kernel - Auto Promotion
 *
 * Ported from Hermes scope-recall experience_promotion.py
 * Automatically extracts reusable playbooks from successful task episodes.
 *
 * Core logic:
 * 1. Scan completed episodes with outcome=success
 * 2. Check if a playbook already exists for the episode
 * 3. Analyze risk level based on capability classes and tokens
 * 4. Create playbook candidate with structured steps
 * 5. Auto-promote low-risk playbooks; flag high-risk for review
 */

import { createHash } from "node:crypto";
import { containsSecret } from "./secret-redaction.js";

// Use any to avoid TypeScript issues with experimental node:sqlite
type DatabaseSync = any;
import {
  CAPABILITY_CLASSES,
  PLAYBOOK_SCHEMA_VERSION,
  type PlaybookStep,
  type ProceduralPlaybook,
  type TaskEpisode,
} from "./experience-models.js";
import {
  createPlaybook,
  updatePlaybookStatus,
  getEpisode,
  listEpisodes,
  type CreatePlaybookParams,
} from "./experience-store.js";

// ============================================================================
// Token Lists for Classification
// ============================================================================

const SUCCESS_TOKENS = [
  "passed", "pass", "ok", "green",
  "完成", "通过", "已验证", "验证完成", "成功",
];

const VERIFICATION_TOKENS = [
  "pytest", "ruff", "doctor", "release gate", "smoke",
  "测试", "检查通过", "验证",
];

const HIGH_RISK_TOKENS = [
  "push", "commit", "tag", "restart", "delete", "rm -",
  "token", "password", "secret", "api key",
  "密钥", "密码", "凭据", "重启", "删除", "推送", "提交仓库",
];

const TOOL_HINTS = [
  "pytest", "ruff", "doctor", "release gate", "terminal",
  "git", "gh", "browser", "web_search", "scope_recall",
];

// ============================================================================
// Configuration
// ============================================================================

export interface PromotionConfig {
  /** Minimum evidence entries required to promote (default: 1) */
  min_evidence: number;
  /** Minimum tool names required (default: 1) */
  min_tool_names: number;
  /** Require verification evidence (default: true) */
  require_verification: boolean;
  /** Auto-promote low-risk playbooks (default: true) */
  auto_promote_low_risk: boolean;
  /** Maximum episodes to process per run (default: 50) */
  max_episodes: number;
}

const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  min_evidence: 1,
  min_tool_names: 1,
  require_verification: true,
  auto_promote_low_risk: true,
  max_episodes: 50,
};

// ============================================================================
// Helper Functions
// ============================================================================

function containsAny(text: string, tokens: string[]): boolean {
  const lowered = text.toLowerCase();
  return tokens.some((token) => lowered.includes(token.toLowerCase()));
}

function containsSecretLikeText(text: string): boolean {
  return containsSecret(text);
}

function hashId(prefix: string, ...parts: unknown[]): string {
  const digest = createHash("sha1")
    .update(parts.map((p) => String(p)).join("\n"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}_${digest}`;
}

function compactText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// ============================================================================
// Risk & Task Classification
// ============================================================================

function detectRiskLevel(evidence: string[], toolNames: string[], goal: string): string {
  const allText = [...evidence, goal].join(" ").toLowerCase();

  if (containsSecretLikeText(allText)) {
    return "secret";
  }

  if (containsAny(allText, HIGH_RISK_TOKENS)) {
    return "high";
  }

  return "low";
}

function classifyTask(goal: string, toolNames: string[]): string {
  const lowered = goal.toLowerCase();
  const isReleaseTask = containsAny(lowered, ["release", "push", "version", "发布", "推送", "版本"]);

  if (lowered.includes("clawlore")) {
    return isReleaseTask ? "clawlore_release_closeout" : "clawlore_quality_check";
  }

  if (lowered.includes("scope-recall") || lowered.includes("scope_recall")) {
    return isReleaseTask ? "scope_recall_release_closeout" : "scope_recall_quality_check";
  }

  if (lowered.includes("openclaw") || lowered.includes("gateway")) {
    return "openclaw_operations";
  }

  if (lowered.includes("config") || lowered.includes("配置")) {
    return "config_change";
  }

  if (lowered.includes("debug") || lowered.includes("排障") || lowered.includes("修复")) {
    return "debugging";
  }

  if (lowered.includes("deploy") || lowered.includes("部署")) {
    return "deployment";
  }

  if (lowered.includes("migrate") || lowered.includes("迁移")) {
    return "migration";
  }

  return "agent_verified_task";
}

function generateTitle(taskClass: string, goal: string): string {
  switch (taskClass) {
    case "clawlore_release_closeout":
      return "ClawLore 发布候选收口经验手册";
    case "clawlore_quality_check":
      return "ClawLore 质量检查经验手册";
    case "scope_recall_release_closeout":
      return "scope-recall 发布候选收口经验手册";
    case "scope_recall_quality_check":
      return "scope-recall 质量检查经验手册";
    case "openclaw_operations":
      return "OpenClaw 运维经验手册";
    case "config_change":
      return "配置变更经验手册";
    case "debugging":
      return "排障修复经验手册";
    case "deployment":
      return "部署经验手册";
    case "migration":
      return "迁移经验手册";
    default: {
      const words = goal.match(/[\w\u4e00-\u9fff-]+/g) ?? [];
      const suffix = words.slice(0, 8).join(" ") || "自动提取任务";
      return compactText(`${suffix} 经验手册`, 80);
    }
  }
}

// ============================================================================
// Verification Detection
// ============================================================================

function detectVerification(evidence: string[], toolNames: string[]): string[] {
  const allText = evidence.join(" ").toLowerCase();
  const checks: string[] = [];

  if (allText.includes("pytest") || allText.includes("测试")) {
    checks.push("测试结果显示通过。");
  }
  if (allText.includes("ruff") || allText.includes("lint")) {
    checks.push("代码静态检查通过。");
  }
  if (allText.includes("doctor") || allText.includes("health")) {
    checks.push("健康检查通过。");
  }
  if (allText.includes("release gate")) {
    checks.push("发布检查通过。");
  }
  if (allText.includes("curl") && allText.includes("healthz")) {
    checks.push("HTTP 健康端点验证通过。");
  }
  if (allText.includes("systemctl") && allText.includes("active")) {
    checks.push("服务状态验证为 active。");
  }

  if (checks.length === 0 && containsAny(allText, VERIFICATION_TOKENS)) {
    checks.push("任务记录包含明确验证信号。");
  }

  return checks;
}

// ============================================================================
// Playbook Payload Generation
// ============================================================================

function buildPlaybookPayload(params: {
  taskClass: string;
  title: string;
  goal: string;
  riskLevel: string;
  toolNames: string[];
  verification: string[];
  evidence: string[];
}): Record<string, unknown> {
  const { taskClass, title, goal, riskLevel, toolNames, verification, evidence } = params;
  const isHighRisk = riskLevel === "high" || riskLevel === "secret";
  const capability = isHighRisk ? "local_write" : "read_only";

  const pitfalls: Record<string, unknown>[] = [
    {
      signal: "任务记录来自自动提取",
      mistake: "把一次性结果当成永久事实",
      correction: "复用前必须重新读取现场证据。",
    },
  ];

  if (isHighRisk) {
    pitfalls.push({
      signal: "涉及推送、发布、重启、删除或凭据相邻操作",
      mistake: "自动执行高风险动作",
      correction: "只复用检查流程；执行前必须现场核验并遵守授权边界。",
    });
  }

  const steps: PlaybookStep[] = [
    {
      number: 1,
      capability_class: "read_only",
      action: "先读取当前现场状态，不使用旧记忆替代现场证据。",
      evidence_required: "本轮读取到的文件、仓库、服务或配置状态",
      why: "自动经验只能给流程，不能替代实时事实。",
      previous_mistakes: ["把旧发布状态或旧路径当成当前事实。"],
    },
    {
      number: 2,
      capability_class: capability,
      action: "按已验证顺序执行最小必要检查。",
      evidence_required: toolNames.length > 0 ? toolNames.join(", ") : "相关工具检查输出",
      why: "任务轨迹显示这些检查曾经证明结果可靠。",
      previous_mistakes: [],
    },
    {
      number: 3,
      capability_class: "read_only",
      action: "收尾时明确列出通过项、剩余风险和是否需要授权。",
      evidence_required: "测试/检查结果和授权边界说明",
      why: "避免把候选状态误报成已发布或已执行。",
      previous_mistakes: ["把本地候选版本说成远端正式版本。"],
    },
  ];

  return {
    schema_version: PLAYBOOK_SCHEMA_VERSION,
    task_class: taskClass,
    title,
    trigger: `遇到类似任务：${goal}`,
    goal: "复用已验证的执行顺序，减少重复踩坑，同时保留现场核验。",
    preconditions: [
      { id: "p1", check: "确认当前任务与经验手册目标一致。", evidence_required: "用户请求或任务描述" },
      { id: "p2", check: "复用前重新读取现场状态。", evidence_required: "本轮工具输出或文件/服务状态" },
    ],
    steps,
    pitfalls,
    verification: verification.length > 0 ? verification : ["任务记录包含成功和验证信号。"],
    cleanup: ["清理临时产物或说明未清理原因。", "记录哪些事实需要下次 live check。"],
    reuse_policy: {
      default_decision: isHighRisk ? "guided_reuse" : "direct_reuse",
      allow_direct_reuse: !isHighRisk,
      risk_level: riskLevel,
    },
    status: "candidate",
    confidence: isHighRisk ? 0.78 : 0.86,
  };
}

// ============================================================================
// Core Promotion Logic
// ============================================================================

export interface PromotionResult {
  dry_run: boolean;
  episodes_scanned: number;
  episodes_created: number;
  playbooks_created: number;
  playbooks_promoted: number;
  playbooks_needing_review: number;
  duplicates_skipped: number;
  historical_episodes_frozen: number;
  skipped: number;
  items: PromotionItem[];
}

export interface PromotionItem {
  action: "created" | "would_create" | "skip";
  episode_id?: string;
  playbook_id?: string;
  risk_level?: string;
  status?: string;
  reason?: string;
}

function promotionReviewIssue(episode: TaskEpisode): string | undefined {
  const metadata = episode?.metadata && typeof episode.metadata === "object"
    ? episode.metadata as Record<string, unknown>
    : {};
  const review = metadata.promotion_review && typeof metadata.promotion_review === "object"
    ? metadata.promotion_review as Record<string, unknown>
    : undefined;
  if (!review && metadata.promotion_eligible === undefined && metadata.reviewer_passed === undefined) {
    return "legacy_episode_historical";
  }
  if (metadata.promotion_eligible !== true) return "promotion_not_eligible";
  if (metadata.reviewer_passed !== true) return "promotion_reviewer_not_passed";
  if (!review || review.decision !== "approved" || typeof review.source !== "string" || !review.source.trim()) {
    return "promotion_review_provenance_missing";
  }
  return undefined;
}

export function promoteExperiences(
  db: DatabaseSync,
  options: {
    scope_id?: string;
    config?: Partial<PromotionConfig>;
    dry_run?: boolean;
  } = {},
): PromotionResult {
  const config = { ...DEFAULT_PROMOTION_CONFIG, ...options.config };
  const dryRun = options.dry_run ?? true;

  const result: PromotionResult = {
    dry_run: dryRun,
    episodes_scanned: 0,
    episodes_created: 0,
    playbooks_created: 0,
    playbooks_promoted: 0,
    playbooks_needing_review: 0,
    duplicates_skipped: 0,
    historical_episodes_frozen: 0,
    skipped: 0,
    items: [],
  };

  // Find completed episodes with success outcome that don't have playbooks yet
  const episodes = listEpisodes(db, {
    scope_id: options.scope_id,
    status: "completed",
    limit: config.max_episodes,
  });

  for (const episode of episodes) {
    result.episodes_scanned++;

    // Skip if outcome is not success
    if (episode.outcome !== "success") {
      result.skipped++;
      continue;
    }

    // Task completion and experience governance are separate truths. A
    // successful episode is never promotion authority by itself: automatic
    // extraction requires an explicit positive reviewer decision and its
    // provenance. Pre-gate episodes remain explicit historical records; this
    // release does not silently approve or mutate them into promotion inputs.
    const reviewIssue = promotionReviewIssue(episode);
    if (reviewIssue) {
      result.skipped++;
      if (reviewIssue === "legacy_episode_historical") result.historical_episodes_frozen++;
      result.items.push({ action: "skip", reason: reviewIssue, episode_id: episode.id });
      continue;
    }

    // Skip if not enough evidence
    if (episode.evidence.length < config.min_evidence) {
      result.skipped++;
      continue;
    }

    // Skip if not enough tool names
    if (episode.tool_names.length < config.min_tool_names) {
      result.skipped++;
      continue;
    }

    // Skip if verification required but not present
    if (config.require_verification && episode.verification.length === 0) {
      result.skipped++;
      continue;
    }

    // Check for secret-like content
    const allText = [...episode.evidence, episode.task_goal].join(" ");
    if (containsSecretLikeText(allText)) {
      result.skipped++;
      result.items.push({ action: "skip", reason: "secret-like-content", episode_id: episode.id });
      continue;
    }

    // Check if playbook already exists for this episode
    const existingPlaybook = db.prepare(
      "SELECT id FROM procedural_playbooks WHERE created_from_episode_id = ?",
    ).get(episode.id) as { id: string } | undefined;

    if (existingPlaybook) {
      result.duplicates_skipped++;
      continue;
    }

    // Classify and analyze
    const goal = episode.task_goal || episode.user_intent || "自动提取的任务";
    const taskClass = classifyTask(goal, episode.tool_names);
    const riskLevel = detectRiskLevel(episode.evidence, episode.tool_names, goal);
    const verification = episode.verification.length > 0
      ? episode.verification
      : detectVerification(episode.evidence, episode.tool_names);
    const title = generateTitle(taskClass, goal);
    const playbookId = hashId("pb_auto", episode.id, title);

    if (dryRun) {
      result.episodes_created++;
      result.playbooks_created++;
      if (riskLevel === "low" && config.auto_promote_low_risk) {
        result.playbooks_promoted++;
      } else if (riskLevel === "high") {
        result.playbooks_needing_review++;
      }
      result.items.push({
        action: "would_create",
        episode_id: episode.id,
        playbook_id: playbookId,
        risk_level: riskLevel,
      });
      continue;
    }

    // Build playbook payload
    const payload = buildPlaybookPayload({
      taskClass,
      title,
      goal,
      riskLevel,
      toolNames: episode.tool_names,
      verification,
      evidence: episode.evidence,
    });

    // Create playbook
    const created = createPlaybook(db, {
      scope_id: episode.scope_id,
      shared_scope_id: episode.shared_scope_id,
      payload,
      created_from_episode_id: episode.id,
      evidence_anchors: [`task_episode:${episode.id}`],
      related_skills: [],
      environment_constraints: { risk_level: riskLevel, requires_live_check: true },
      metadata: {
        auto_extracted: true,
        risk_level: riskLevel,
        source: "experience_promotion",
        safe_summary: compactText(allText, 500),
      },
    });

    result.episodes_created++;
    result.playbooks_created++;

    // Auto-promote or flag for review
    let finalStatus = created.status;

    if (riskLevel === "low" && config.auto_promote_low_risk) {
      updatePlaybookStatus(
        db,
        created.id,
        "promoted",
        "自动提取经验自检通过：低风险且有验证证据。",
      );
      finalStatus = "promoted";
      result.playbooks_promoted++;
    } else if (riskLevel === "high") {
      updatePlaybookStatus(
        db,
        created.id,
        "needs_review",
        "自动提取经验自检发现高风险动作；需要后续代理复核。",
      );
      finalStatus = "needs_review";
      result.playbooks_needing_review++;
    }

    result.items.push({
      action: "created",
      episode_id: episode.id,
      playbook_id: created.id,
      risk_level: riskLevel,
      status: finalStatus,
    });
  }

  return result;
}

// ============================================================================
// Forgetting Loop (Phase 4 preview)
// ============================================================================

export interface ForgettingResult {
  dry_run: boolean;
  candidates_found: number;
  superseded: number;
  quarantined: number;
  items: ForgettingItem[];
}

export interface ForgettingItem {
  action: "supersede" | "quarantine" | "keep";
  playbook_id: string;
  reason: string;
}

/**
 * Identify low-quality or stale playbooks for cleanup.
 *
 * Criteria:
 * - Superseded: newer playbook with same task_class exists and is promoted
 * - Quarantine: failure_count > success_count * 2 and total runs >= 3
 */
export function runForgettingLoop(
  db: DatabaseSync,
  options: { scope_id?: string; dry_run?: boolean } = {},
): ForgettingResult {
  const dryRun = options.dry_run ?? true;
  const result: ForgettingResult = {
    dry_run: dryRun,
    candidates_found: 0,
    superseded: 0,
    quarantined: 0,
    items: [],
  };

  // Find superseded playbooks: same task_class, older, not promoted
  const allPlaybooks = db.prepare(`
    SELECT * FROM procedural_playbooks
    WHERE status IN ('candidate', 'reviewed')
    ORDER BY task_class, created_at DESC
  `).all() as Record<string, unknown>[];

  const promotedByClass = new Map<string, string>();

  // First pass: find promoted playbooks per task_class
  const promoted = db.prepare(`
    SELECT task_class, id, created_at FROM procedural_playbooks
    WHERE status = 'promoted'
    ORDER BY created_at DESC
  `).all() as { task_class: string; id: string; created_at: string }[];

  for (const p of promoted) {
    if (!promotedByClass.has(p.task_class)) {
      promotedByClass.set(p.task_class, p.id);
    }
  }

  // Second pass: mark candidates as superseded if a promoted version exists
  for (const pb of allPlaybooks) {
    const taskClass = pb.task_class as string;
    const pbId = pb.id as string;

    if (promotedByClass.has(taskClass) && promotedByClass.get(taskClass) !== pbId) {
      result.candidates_found++;
      result.items.push({
        action: "supersede",
        playbook_id: pbId,
        reason: `已有同 task_class (${taskClass}) 的 promoted playbook`,
      });

      if (!dryRun) {
        updatePlaybookStatus(db, pbId, "superseded", "被同 task_class 的 promoted playbook 取代");
      }
      result.superseded++;
    }
  }

  // Find failing playbooks: failure_count > success_count * 2
  const failing = db.prepare(`
    SELECT id, success_count, failure_count FROM procedural_playbooks
    WHERE status IN ('candidate', 'reviewed', 'promoted')
    AND failure_count > 0
    AND (success_count + failure_count) >= 3
  `).all() as { id: string; success_count: number; failure_count: number }[];

  for (const pb of failing) {
    if (pb.failure_count > pb.success_count * 2) {
      result.candidates_found++;
      result.items.push({
        action: "quarantine",
        playbook_id: pb.id,
        reason: `失败率过高: ${pb.failure_count} failures vs ${pb.success_count} successes`,
      });

      if (!dryRun) {
        updatePlaybookStatus(db, pb.id, "quarantined", "失败率过高，自动隔离");
      }
      result.quarantined++;
    }
  }

  return result;
}
