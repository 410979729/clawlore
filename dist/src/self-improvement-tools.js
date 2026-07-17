/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendSelfImprovementEntry, ensureSelfImprovementLearningFiles } from "./self-improvement-files.js";
import { escapeRegExp, resolveWorkspaceDir, safeToolFailure, stringEnum } from "./tool-runtime-policy.js";
export function registerSelfImprovementLogTool(api, context) {
    api.registerTool((toolCtx) => ({
        name: "self_improvement_log",
        label: "Self-Improvement Log",
        description: "Log structured learning/error entries into .learnings for governance and later distillation.",
        parameters: Type.Object({
            type: stringEnum(["learning", "error"]),
            summary: Type.String({ description: "One-line summary" }),
            details: Type.Optional(Type.String({ description: "Detailed context or error output" })),
            suggestedAction: Type.Optional(Type.String({ description: "Concrete action to prevent recurrence" })),
            category: Type.Optional(Type.String({ description: "learning category (correction/best_practice/knowledge_gap) when type=learning" })),
            area: Type.Optional(Type.String({ description: "frontend|backend|infra|tests|docs|config or custom area" })),
            priority: Type.Optional(Type.String({ description: "low|medium|high|critical" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
            const { type, summary, details = "", suggestedAction = "", category = "best_practice", area = "config", priority = "medium", } = params;
            try {
                const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
                const { id: entryId, filePath } = await appendSelfImprovementEntry({
                    baseDir: workspaceDir,
                    type,
                    summary,
                    details,
                    suggestedAction,
                    category,
                    area,
                    priority,
                    source: "clawlore/self_improvement_log",
                });
                const fileName = type === "learning" ? "LEARNINGS.md" : "ERRORS.md";
                return {
                    content: [{ type: "text", text: `Logged ${type} entry ${entryId} to .learnings/${fileName}` }],
                    details: { action: "logged", type, id: entryId, filePath },
                };
            }
            catch (error) {
                return safeToolFailure("self_improvement_log_failed", "Failed to log self-improvement entry", error);
            }
        },
    }), { name: "self_improvement_log" });
}
export function registerSelfImprovementExtractSkillTool(api, context) {
    api.registerTool((toolCtx) => ({
        name: "self_improvement_extract_skill",
        label: "Extract Skill From Learning",
        description: "Create a new skill scaffold from a learning entry and mark the source learning as promoted_to_skill.",
        parameters: Type.Object({
            learningId: Type.String({ description: "Learning ID like LRN-YYYYMMDD-001" }),
            skillName: Type.String({ description: "Skill folder name, lowercase with hyphens" }),
            sourceFile: Type.Optional(stringEnum(["LEARNINGS.md", "ERRORS.md"])),
            outputDir: Type.Optional(Type.String({ description: "Relative output dir under workspace (default: skills)" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
            const { learningId, skillName, sourceFile = "LEARNINGS.md", outputDir = "skills" } = params;
            try {
                if (!/^(LRN|ERR)-\d{8}-\d{3}$/.test(learningId)) {
                    return {
                        content: [{ type: "text", text: "Invalid learningId format. Use LRN-YYYYMMDD-001 / ERR-..." }],
                        details: { error: "invalid_learning_id" },
                    };
                }
                if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
                    return {
                        content: [{ type: "text", text: "Invalid skillName. Use lowercase letters, numbers, and hyphens only." }],
                        details: { error: "invalid_skill_name" },
                    };
                }
                const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
                await ensureSelfImprovementLearningFiles(workspaceDir);
                const learningsPath = join(workspaceDir, ".learnings", sourceFile);
                const learningBody = await readFile(learningsPath, "utf-8");
                const escapedLearningId = escapeRegExp(learningId.trim());
                const entryRegex = new RegExp(`## \\[${escapedLearningId}\\][\\s\\S]*?(?=\\n## \\[|$)`, "m");
                const match = learningBody.match(entryRegex);
                if (!match) {
                    return {
                        content: [{ type: "text", text: `Learning entry ${learningId} not found in .learnings/${sourceFile}` }],
                        details: { error: "learning_not_found", learningId, sourceFile },
                    };
                }
                const summaryMatch = match[0].match(/### Summary\n([\s\S]*?)\n###/m);
                const summary = (summaryMatch?.[1] ?? "Summarize the source learning here.").trim();
                const safeOutputDir = outputDir
                    .replace(/\\/g, "/")
                    .split("/")
                    .filter((segment) => segment && segment !== "." && segment !== "..")
                    .join("/");
                const skillDir = join(workspaceDir, safeOutputDir || "skills", skillName);
                await mkdir(skillDir, { recursive: true });
                const skillPath = join(skillDir, "SKILL.md");
                const skillTitle = skillName
                    .split("-")
                    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
                    .join(" ");
                const skillContent = [
                    "---",
                    `name: ${skillName}`,
                    `description: "Extracted from learning ${learningId}. Replace with a concise description."`,
                    "---",
                    "",
                    `# ${skillTitle}`,
                    "",
                    "## Why",
                    summary,
                    "",
                    "## When To Use",
                    "- [TODO] Define trigger conditions",
                    "",
                    "## Steps",
                    "1. [TODO] Add repeatable workflow steps",
                    "2. [TODO] Add verification steps",
                    "",
                    "## Source Learning",
                    `- Learning ID: ${learningId}`,
                    `- Source File: .learnings/${sourceFile}`,
                    "",
                ].join("\n");
                await writeFile(skillPath, skillContent, "utf-8");
                const promotedMarker = `**Status**: promoted_to_skill`;
                const skillPathMarker = `- Skill-Path: ${safeOutputDir || "skills"}/${skillName}`;
                let updatedEntry = match[0];
                updatedEntry = updatedEntry.includes("**Status**:")
                    ? updatedEntry.replace(/\*\*Status\*\*:\s*.+/m, promotedMarker)
                    : `${updatedEntry.trimEnd()}\n${promotedMarker}\n`;
                if (!updatedEntry.includes("Skill-Path:")) {
                    updatedEntry = `${updatedEntry.trimEnd()}\n${skillPathMarker}\n`;
                }
                const updatedLearningBody = learningBody.replace(match[0], updatedEntry);
                await writeFile(learningsPath, updatedLearningBody, "utf-8");
                return {
                    content: [{ type: "text", text: `Extracted skill scaffold to ${safeOutputDir || "skills"}/${skillName}/SKILL.md and updated ${learningId}.` }],
                    details: {
                        action: "skill_extracted",
                        learningId,
                        sourceFile,
                        skillPath: `${safeOutputDir || "skills"}/${skillName}/SKILL.md`,
                    },
                };
            }
            catch (error) {
                return safeToolFailure("self_improvement_extract_skill_failed", "Failed to extract skill", error);
            }
        },
    }), { name: "self_improvement_extract_skill" });
}
export function registerSelfImprovementReviewTool(api, context) {
    api.registerTool((toolCtx) => ({
        name: "self_improvement_review",
        label: "Self-Improvement Review",
        description: "Summarize governance backlog from .learnings files (pending/high-priority/promoted counts).",
        parameters: Type.Object({}),
        async execute() {
            try {
                const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
                await ensureSelfImprovementLearningFiles(workspaceDir);
                const learningsDir = join(workspaceDir, ".learnings");
                const files = ["LEARNINGS.md", "ERRORS.md"];
                const stats = { pending: 0, high: 0, promoted: 0, total: 0 };
                for (const f of files) {
                    const content = await readFile(join(learningsDir, f), "utf-8").catch(() => "");
                    stats.total += (content.match(/^## \[/gm) || []).length;
                    stats.pending += (content.match(/\*\*Status\*\*:\s*pending/gi) || []).length;
                    stats.high += (content.match(/\*\*Priority\*\*:\s*(high|critical)/gi) || []).length;
                    stats.promoted += (content.match(/\*\*Status\*\*:\s*promoted(_to_skill)?/gi) || []).length;
                }
                const text = [
                    "Self-Improvement Governance Snapshot:",
                    `- Total entries: ${stats.total}`,
                    `- Pending: ${stats.pending}`,
                    `- High/Critical: ${stats.high}`,
                    `- Promoted: ${stats.promoted}`,
                    "",
                    "Recommended loop:",
                    "1) Resolve high-priority pending entries",
                    "2) Distill reusable rules into AGENTS.md / SOUL.md / TOOLS.md",
                    "3) Extract repeatable patterns as skills",
                ].join("\n");
                return {
                    content: [{ type: "text", text }],
                    details: { action: "review", stats },
                };
            }
            catch (error) {
                return safeToolFailure("self_improvement_review_failed", "Failed to review self-improvement backlog", error);
            }
        },
    }), { name: "self_improvement_review" });
}
// ============================================================================
// Core Tools (Backward Compatible)
// ============================================================================
