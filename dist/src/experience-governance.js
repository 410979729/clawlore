/**
 * Experience governance debt reporting.
 *
 * This module is intentionally read-only. It helps operators see where the
 * episode -> playbook -> promoted procedure chain is stuck before any
 * promotion, review, quarantine, or cleanup command mutates storage.
 */
const REQUIRED_TABLES = [
    "task_episodes",
    "procedural_playbooks",
    "procedural_playbooks_fts",
    "playbook_versions",
    "experience_runs",
    "task_experience_capture_events",
];
const DEFAULT_LIMIT = 20;
const DEFAULT_STALE_CANDIDATE_DAYS = 14;
const FAILING_MIN_RUNS = 3;
const FAILING_FAILURE_MULTIPLIER = 2;
const SECRET_LIKE_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    /\bAIza[A-Za-z0-9_-]{8,}\b/g,
    /\b(?:api[_-]?key|token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*["']?[^"'\s,;]{4,}/gi,
    /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];
function tableNames(db) {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all();
    return new Set(rows.map((row) => String(row.name)));
}
function missingTables(db) {
    const existing = tableNames(db);
    return REQUIRED_TABLES.filter((name) => !existing.has(name));
}
function groupedCounts(rows, key) {
    const counts = {};
    for (const row of rows) {
        const value = String(row[key] ?? "");
        counts[value] = (counts[value] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
function safeArray(value) {
    if (Array.isArray(value))
        return value;
    if (typeof value !== "string" || !value.trim())
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function arrayCount(value) {
    return safeArray(value).length;
}
function containsSecretLikeText(text) {
    return SECRET_LIKE_PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(text);
    });
}
function redactSecretLikeText(text) {
    let redacted = text;
    for (const pattern of SECRET_LIKE_PATTERNS) {
        pattern.lastIndex = 0;
        redacted = redacted.replace(pattern, "[redacted: secret-like content]");
    }
    return redacted;
}
function preview(value, maxChars = 140) {
    const text = redactSecretLikeText(String(value ?? "").replace(/\s+/g, " ").trim());
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
function ageDays(value, nowMs) {
    const parsed = Date.parse(String(value ?? ""));
    if (!Number.isFinite(parsed))
        return 0;
    return Math.max(0, Math.floor((nowMs - parsed) / 86_400_000));
}
function clampLimit(value) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed))
        return DEFAULT_LIMIT;
    return Math.max(1, Math.min(parsed, 200));
}
function scopeWhere(scopeId) {
    if (!scopeId)
        return { where: "", params: [] };
    return { where: "WHERE (scope_id = ? OR shared_scope_id = ?)", params: [scopeId, scopeId] };
}
function runScopeWhere(scopeId) {
    if (!scopeId)
        return { where: "", params: [] };
    return { where: "WHERE scope_id = ?", params: [scopeId] };
}
function limited(items, limit) {
    return items.slice(0, limit);
}
function makeRecommendation(kind, count, action, command) {
    return command ? { kind, count, command, action } : { kind, count, action };
}
export function buildExperienceDebtReport(db, options = {}) {
    const nowMs = options.now_ms ?? Date.now();
    const generatedAt = new Date(nowMs).toISOString();
    const staleCandidateDays = Math.max(1, Number.parseInt(String(options.stale_candidate_days ?? DEFAULT_STALE_CANDIDATE_DAYS), 10)
        || DEFAULT_STALE_CANDIDATE_DAYS);
    const limit = clampLimit(options.limit);
    const missing = missingTables(db);
    const base = {
        generated_at: generatedAt,
        scope_id: options.scope_id,
        thresholds: {
            stale_candidate_days: staleCandidateDays,
            failing_min_runs: FAILING_MIN_RUNS,
            failing_failure_multiplier: FAILING_FAILURE_MULTIPLIER,
        },
        totals: {
            episodes: {},
            playbooks: {},
            runs: {},
            capture_events: {},
            capture_skip_reasons: {},
        },
        debt: {
            ready_to_promote_episodes: { count: 0, items: [] },
            blocked_success_episodes: { count: 0, items: [] },
            review_backlog_playbooks: { count: 0, items: [] },
            stale_candidate_playbooks: { count: 0, items: [] },
            failing_playbooks: { count: 0, items: [] },
            skipped_capture_events: { count: 0, items: [] },
        },
        recommendations: [],
    };
    if (missing.length > 0) {
        return {
            ...base,
            status: "schema_missing",
            missing_tables: missing,
        };
    }
    const episodeScope = scopeWhere(options.scope_id);
    const playbookScope = scopeWhere(options.scope_id);
    const runScope = runScopeWhere(options.scope_id);
    const captureScope = runScopeWhere(options.scope_id);
    const episodes = db.prepare(`
    SELECT id, scope_id, shared_scope_id, task_class, task_goal, status, outcome,
           started_at, ended_at, tool_names, evidence, verification, metadata
    FROM task_episodes
    ${episodeScope.where}
    ORDER BY started_at DESC
  `).all(...episodeScope.params);
    const playbooks = db.prepare(`
    SELECT id, scope_id, shared_scope_id, task_class, title, status, confidence,
           success_count, failure_count, stale_count, created_from_episode_id,
           superseded_by, last_used_at, last_verified_at, created_at, updated_at,
           metadata
    FROM procedural_playbooks
    ${playbookScope.where}
    ORDER BY updated_at DESC
  `).all(...playbookScope.params);
    const runs = db.prepare(`
    SELECT id, playbook_id, scope_id, decision, outcome, started_at, finished_at
    FROM experience_runs
    ${runScope.where}
  `).all(...runScope.params);
    const captureEvents = db.prepare(`
    SELECT id, scope_id, session_id, agent_id, action, reason, task_class,
           memory_id, existing_memory_id, similarity, created_at, metadata
    FROM task_experience_capture_events
    ${captureScope.where}
    ORDER BY created_at DESC
  `).all(...captureScope.params);
    const linkedEpisodeIds = new Set(playbooks
        .map((row) => String(row.created_from_episode_id ?? "").trim())
        .filter(Boolean));
    const successfulCompleted = episodes.filter((row) => row.status === "completed" && row.outcome === "success");
    const readyToPromote = [];
    const blockedSuccess = [];
    for (const row of successfulCompleted) {
        if (linkedEpisodeIds.has(String(row.id)))
            continue;
        const evidenceCount = arrayCount(row.evidence);
        const toolCount = arrayCount(row.tool_names);
        const verificationCount = arrayCount(row.verification);
        const textForSafety = [
            row.task_goal,
            ...safeArray(row.evidence),
            ...safeArray(row.verification),
        ].join(" ");
        const reasons = [];
        if (evidenceCount === 0)
            reasons.push("missing_evidence");
        if (toolCount === 0)
            reasons.push("missing_tool_names");
        if (verificationCount === 0)
            reasons.push("missing_verification");
        if (containsSecretLikeText(textForSafety))
            reasons.push("secret_like_content");
        const item = {
            id: String(row.id),
            scope_id: String(row.scope_id ?? ""),
            task_class: String(row.task_class ?? ""),
            task_goal: preview(row.task_goal),
            age_days: ageDays(row.ended_at ?? row.started_at, nowMs),
            evidence_count: evidenceCount,
            tool_count: toolCount,
            verification_count: verificationCount,
            reasons,
        };
        if (reasons.length === 0) {
            readyToPromote.push(item);
        }
        else {
            blockedSuccess.push(item);
        }
    }
    const reviewStatuses = new Set(["candidate", "reviewed", "needs_review"]);
    const staleStatuses = new Set(["candidate", "reviewed", "needs_review"]);
    const failingStatuses = new Set(["candidate", "reviewed", "needs_review", "promoted"]);
    const reviewBacklog = [];
    const staleCandidates = [];
    const failingPlaybooks = [];
    const skippedCaptureEvents = [];
    for (const row of playbooks) {
        const status = String(row.status ?? "");
        const updatedAgeDays = ageDays(row.updated_at ?? row.created_at, nowMs);
        const successCount = Number(row.success_count ?? 0);
        const failureCount = Number(row.failure_count ?? 0);
        const totalFeedback = successCount + failureCount;
        const item = {
            id: String(row.id),
            scope_id: String(row.scope_id ?? ""),
            task_class: String(row.task_class ?? ""),
            title: preview(row.title),
            status,
            age_days: updatedAgeDays,
            success_count: successCount,
            failure_count: failureCount,
            failure_rate: totalFeedback > 0 ? Number((failureCount / totalFeedback).toFixed(3)) : 0,
            reasons: [],
        };
        if (reviewStatuses.has(status)) {
            reviewBacklog.push({ ...item, reasons: [`status_${status}`] });
        }
        if (staleStatuses.has(status) && updatedAgeDays >= staleCandidateDays) {
            staleCandidates.push({ ...item, reasons: [`older_than_${staleCandidateDays}_days`] });
        }
        if (failingStatuses.has(status)
            && totalFeedback >= FAILING_MIN_RUNS
            && failureCount > successCount * FAILING_FAILURE_MULTIPLIER) {
            failingPlaybooks.push({ ...item, reasons: ["failure_rate_too_high"] });
        }
    }
    for (const row of captureEvents) {
        if (String(row.action ?? "") !== "skipped")
            continue;
        const reason = String(row.reason ?? "unknown").trim() || "unknown";
        skippedCaptureEvents.push({
            id: String(row.id),
            scope_id: String(row.scope_id ?? ""),
            task_class: String(row.task_class ?? ""),
            status: "skipped",
            action: "skipped",
            reason: preview(reason, 120),
            memory_id: String(row.memory_id ?? ""),
            existing_memory_id: String(row.existing_memory_id ?? ""),
            similarity: Number(row.similarity ?? 0),
            age_days: ageDays(row.created_at, nowMs),
            reasons: [reason],
        });
    }
    const recommendations = [];
    if (readyToPromote.length > 0) {
        recommendations.push(makeRecommendation("ready_to_promote_episodes", readyToPromote.length, "Run a dry-run promotion batch, inspect proposed playbooks, then apply only if evidence is clean.", "openclaw scope-recall experience promote --dry-run --json"));
    }
    if (reviewBacklog.length > 0) {
        recommendations.push(makeRecommendation("review_backlog_playbooks", reviewBacklog.length, "Review candidates, promote safe low-risk procedures, or mark unsafe items needs_review/quarantined.", "openclaw scope-recall playbooks list --status candidate --json"));
    }
    if (staleCandidates.length > 0) {
        recommendations.push(makeRecommendation("stale_candidate_playbooks", staleCandidates.length, "Replay or supersede stale candidates before treating them as reusable procedures.", "openclaw scope-recall experience replay --playbook-id <id> --json"));
    }
    if (failingPlaybooks.length > 0) {
        recommendations.push(makeRecommendation("failing_playbooks", failingPlaybooks.length, "Quarantine or revise playbooks with repeated failures before future preflight reuse.", "openclaw scope-recall playbooks quarantine --id <id> --json"));
    }
    if (skippedCaptureEvents.length > 0) {
        recommendations.push(makeRecommendation("skipped_capture_events", skippedCaptureEvents.length, "Inspect skipped task-experience captures before tuning reviewer prompts or capture gates; do not auto-promote skipped transcripts.", "openclaw scope-recall experience debt --json"));
    }
    if (recommendations.length === 0) {
        recommendations.push(makeRecommendation("no_action", 0, "No Experience governance debt matched the current thresholds."));
    }
    const debtCount = readyToPromote.length
        + blockedSuccess.length
        + reviewBacklog.length
        + staleCandidates.length
        + failingPlaybooks.length
        + skippedCaptureEvents.length;
    return {
        ...base,
        status: debtCount > 0 ? "attention_needed" : "ok",
        totals: {
            episodes: {
                total: episodes.length,
                ...groupedCounts(episodes, "status"),
                completed_success: successfulCompleted.length,
                completed_success_linked: successfulCompleted.filter((row) => linkedEpisodeIds.has(String(row.id))).length,
                completed_success_unlinked: successfulCompleted.filter((row) => !linkedEpisodeIds.has(String(row.id))).length,
            },
            playbooks: {
                total: playbooks.length,
                ...groupedCounts(playbooks, "status"),
            },
            runs: {
                total: runs.length,
                ...groupedCounts(runs, "outcome"),
            },
            capture_events: {
                total: captureEvents.length,
                ...groupedCounts(captureEvents, "action"),
            },
            capture_skip_reasons: groupedCounts(captureEvents.filter((row) => String(row.action ?? "") === "skipped"), "reason"),
        },
        debt: {
            ready_to_promote_episodes: {
                count: readyToPromote.length,
                items: limited(readyToPromote, limit),
            },
            blocked_success_episodes: {
                count: blockedSuccess.length,
                items: limited(blockedSuccess, limit),
            },
            review_backlog_playbooks: {
                count: reviewBacklog.length,
                items: limited(reviewBacklog, limit),
            },
            stale_candidate_playbooks: {
                count: staleCandidates.length,
                items: limited(staleCandidates, limit),
            },
            failing_playbooks: {
                count: failingPlaybooks.length,
                items: limited(failingPlaybooks, limit),
            },
            skipped_capture_events: {
                count: skippedCaptureEvents.length,
                items: limited(skippedCaptureEvents, limit),
            },
        },
        recommendations,
    };
}
