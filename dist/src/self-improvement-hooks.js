import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { diagnosticErrorSummary, diagnosticIdentifier } from "./diagnostic-redaction.js";
import { ensureSelfImprovementLearningFiles } from "./self-improvement-files.js";
const DEFAULT_REMINDER = `## Self-Improvement Reminder

After completing tasks, evaluate if any learnings should be captured:

**Log when:**
- User corrects you -> .learnings/LEARNINGS.md
- Command/operation fails -> .learnings/ERRORS.md
- You discover your knowledge was wrong -> .learnings/LEARNINGS.md
- You find a better approach -> .learnings/LEARNINGS.md

**Promote when pattern is proven:**
- Behavioral patterns -> SOUL.md
- Workflow improvements -> AGENTS.md
- Tool gotchas -> TOOLS.md

Keep entries simple: date, title, what happened, what to do differently.`;
const NOTE_PREFIX = "/note self-improvement (before reset):";
async function loadReminder(workspaceDir) {
    const baseDir = typeof workspaceDir === "string" ? workspaceDir.trim() : "";
    if (!baseDir)
        return DEFAULT_REMINDER;
    try {
        const content = await readFile(join(baseDir, "SELF_IMPROVEMENT_REMINDER.md"), "utf-8");
        return content.trim() || DEFAULT_REMINDER;
    }
    catch {
        return DEFAULT_REMINDER;
    }
}
/** Registers bootstrap and pre-reset learning reminders without persisting session content. */
export function registerSelfImprovementHooks(params) {
    const { api, config } = params;
    if (config.selfImprovement?.enabled !== true)
        return;
    api.registerHook("agent:bootstrap", async (event) => {
        try {
            const context = (event.context || {});
            const sessionKey = typeof event.sessionKey === "string" ? event.sessionKey : "";
            const workspaceDir = params.resolveWorkspaceDir(context);
            if (params.isInternalSession(sessionKey))
                return;
            if (config.selfImprovement?.skipSubagentBootstrap !== false && sessionKey.includes(":subagent:"))
                return;
            if (config.selfImprovement?.ensureLearningFiles !== false) {
                await ensureSelfImprovementLearningFiles(workspaceDir);
            }
            const bootstrapFiles = context.bootstrapFiles;
            if (!Array.isArray(bootstrapFiles))
                return;
            const exists = bootstrapFiles.some((file) => {
                if (!file || typeof file !== "object")
                    return false;
                return file.path === "SELF_IMPROVEMENT_REMINDER.md";
            });
            if (exists)
                return;
            bootstrapFiles.push({
                path: "SELF_IMPROVEMENT_REMINDER.md",
                content: await loadReminder(workspaceDir),
                virtual: true,
            });
        }
        catch (error) {
            api.logger.warn(`self-improvement: bootstrap inject failed: ${diagnosticErrorSummary(error)}`);
        }
    }, {
        name: "clawlore.self-improvement.agent-bootstrap",
        description: "Inject self-improvement reminder on agent bootstrap",
    });
    if (config.selfImprovement?.beforeResetNote !== false) {
        const appendNote = async (event) => {
            try {
                const action = String(event?.action || "unknown");
                const sessionKey = typeof event?.sessionKey === "string" ? event.sessionKey : "";
                const context = event?.context && typeof event.context === "object"
                    ? event.context
                    : {};
                const commandSource = typeof context.commandSource === "string" ? context.commandSource : "";
                const contextKeys = Object.keys(context).slice(0, 8).join(",");
                api.logger.info(`self-improvement: command:${action} hook start; session=${diagnosticIdentifier(sessionKey)}; source=${diagnosticIdentifier(commandSource)}; hasMessages=${Array.isArray(event?.messages)}; contextKeys=${contextKeys || "(none)"}`);
                if (!Array.isArray(event.messages)) {
                    api.logger.warn(`self-improvement: command:${action} missing event.messages array; skip note inject`);
                    return;
                }
                if (event.messages.some((message) => typeof message === "string" && message.includes(NOTE_PREFIX))) {
                    api.logger.info(`self-improvement: command:${action} note already present; skip duplicate inject`);
                    return;
                }
                event.messages.push([
                    NOTE_PREFIX,
                    "- If anything was learned/corrected, log it now:",
                    "  - .learnings/LEARNINGS.md (corrections/best practices)",
                    "  - .learnings/ERRORS.md (failures/root causes)",
                    "- Distill reusable rules to AGENTS.md / SOUL.md / TOOLS.md.",
                    "- If reusable across tasks, extract a new skill from the learning.",
                    "- Then proceed with the new session.",
                ].join("\n"));
                api.logger.info(`self-improvement: command:${action} injected note; messages=${event.messages.length}`);
            }
            catch (error) {
                api.logger.warn(`self-improvement: note inject failed: ${diagnosticErrorSummary(error)}`);
            }
        };
        api.registerHook("command:new", appendNote, {
            name: "clawlore.self-improvement.command-new",
            description: "Append self-improvement note before /new",
        });
        api.registerHook("command:reset", appendNote, {
            name: "clawlore.self-improvement.command-reset",
            description: "Append self-improvement note before /reset",
        });
    }
    params.logRegistration("self-improvement: integrated hooks registered (agent:bootstrap, command:new, command:reset)");
}
