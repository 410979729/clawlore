import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
const DEFAULT_HOST_MEMORY_WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace");
/** Resolves the host Markdown-memory workspace used only by the compatibility bridge. */
export function resolveHostMemoryWorkspaceDir(api) {
    const configRecord = (api.config ?? {});
    const configured = typeof configRecord.workspaceDir === "string"
        ? configRecord.workspaceDir.trim()
        : "";
    if (configured)
        return resolve(configured);
    const envDir = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
    if (envDir)
        return resolve(envDir);
    return resolve(DEFAULT_HOST_MEMORY_WORKSPACE_DIR);
}
async function listMarkdownFilesRecursive(rootDir) {
    const found = [];
    const stack = [rootDir];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current)
            continue;
        let entries = [];
        try {
            entries = await readdir(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = join(current, entry.name);
            if (entry.isDirectory())
                stack.push(fullPath);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
                found.push(fullPath);
        }
    }
    return found.sort();
}
function buildSnippetWithLines(text, index, radius = 180) {
    const safeIndex = Math.max(0, Math.min(index, text.length));
    const start = Math.max(0, safeIndex - radius);
    const end = Math.min(text.length, safeIndex + radius);
    const snippet = text.slice(start, end).trim();
    const startLine = text.slice(0, start).split(/\r?\n/).length;
    const endLine = Math.max(startLine, text.slice(0, end).split(/\r?\n/).length);
    return { snippet, startLine, endLine };
}
export function scoreMarkdownMatch(query, text) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery)
        return { score: 0, index: -1 };
    const haystack = text.toLowerCase();
    const directIndex = haystack.indexOf(normalizedQuery);
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    let hits = 0;
    let firstIndex = directIndex;
    for (const term of terms) {
        const termIndex = haystack.indexOf(term);
        if (termIndex >= 0) {
            hits += 1;
            if (firstIndex < 0 || termIndex < firstIndex)
                firstIndex = termIndex;
        }
    }
    if (directIndex < 0 && hits === 0)
        return { score: 0, index: -1 };
    const fullMatchBoost = directIndex >= 0 ? 0.35 : 0;
    const termScore = terms.length > 0 ? Math.min(0.55, hits / terms.length) : 0.2;
    return {
        score: Math.min(0.99, 0.1 + fullMatchBoost + termScore),
        index: firstIndex >= 0 ? firstIndex : 0,
    };
}
function resolveWorkspaceFile(workspaceDir, relPath) {
    if (!relPath.trim() || isAbsolute(relPath)) {
        throw new Error("clawlore: invalid Markdown relPath");
    }
    const target = resolve(workspaceDir, relPath);
    const relation = relative(workspaceDir, target);
    if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
        throw new Error("clawlore: invalid Markdown relPath");
    }
    return target;
}
export function createCompatMemorySearchManager(params) {
    const workspaceDir = resolve(params.workspaceDir);
    const memoryRoot = join(workspaceDir, "memory");
    return {
        async search(query, opts) {
            const files = await listMarkdownFilesRecursive(memoryRoot);
            const maxResults = Math.max(1, Math.min(20, opts?.maxResults ?? 8));
            const minScore = typeof opts?.minScore === "number" ? opts.minScore : 0.15;
            const results = [];
            for (const filePath of files) {
                let content = "";
                try {
                    content = await readFile(filePath, "utf-8");
                }
                catch {
                    continue;
                }
                const { score, index } = scoreMarkdownMatch(query, content);
                if (score < minScore || index < 0)
                    continue;
                const { snippet, startLine, endLine } = buildSnippetWithLines(content, index);
                results.push({
                    path: relative(workspaceDir, filePath).replaceAll("\\", "/"),
                    startLine,
                    endLine,
                    score,
                    snippet,
                    source: "memory",
                });
            }
            return results.sort((left, right) => right.score - left.score).slice(0, maxResults);
        },
        async readFile(params2) {
            const target = resolveWorkspaceFile(workspaceDir, params2.relPath);
            const text = await readFile(target, "utf-8");
            const lines = text.split(/\r?\n/);
            if (typeof params2.from !== "number" && typeof params2.lines !== "number") {
                return { text, path: params2.relPath };
            }
            const startLine = Math.max(1, params2.from ?? 1);
            const lineCount = Math.max(1, params2.lines ?? lines.length);
            return {
                text: lines.slice(startLine - 1, startLine - 1 + lineCount).join("\n"),
                path: params2.relPath,
            };
        },
        status() {
            return {
                backend: "builtin",
                provider: params.provider,
                model: params.model,
                workspaceDir,
                dbPath: params.dbPath,
                sources: ["memory"],
                custom: {
                    bridge: "markdown-search-compat",
                    pluginVersion: params.pluginVersion,
                    memoryRoot,
                },
            };
        },
        async probeEmbeddingAvailability() {
            return { ok: true };
        },
        async probeVectorAvailability() {
            return true;
        },
    };
}
export function buildCompatMemoryPromptSection({ availableTools, citationsMode, }) {
    const hasMemorySearch = availableTools.has("memory_search");
    const hasMemoryGet = availableTools.has("memory_get");
    if (!hasMemorySearch && !hasMemoryGet)
        return [];
    let guidance = "Before answering anything about prior work, decisions, dates, people, preferences, or todos: consult memory tools first.";
    if (hasMemorySearch && hasMemoryGet) {
        guidance = "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search first, then use memory_get to inspect the exact lines you need. If confidence stays low, say you checked.";
    }
    else if (hasMemorySearch) {
        guidance = "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search and answer from the matching snippets. If confidence stays low, say you checked.";
    }
    else if (hasMemoryGet) {
        guidance = "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a file: run memory_get to inspect the exact lines you need. If confidence stays low, say you checked.";
    }
    const lines = ["## Memory Recall", guidance];
    if (citationsMode === "off") {
        lines.push("Citations are disabled: do not mention file paths or line numbers unless the user explicitly asks.");
    }
    else {
        lines.push("Citations: include Source: <path#line> when it helps the user verify memory snippets.");
    }
    lines.push("");
    return lines;
}
/** Registers the legacy Markdown search bridge only when the host exposes the optional hooks. */
export function registerMarkdownCompatibility(params) {
    const { api } = params;
    const registerMemoryPromptSection = api.registerMemoryPromptSection;
    const registerMemoryFlushPlan = api.registerMemoryFlushPlan;
    const registerMemoryRuntime = api.registerMemoryRuntime;
    if (typeof registerMemoryPromptSection !== "function"
        && typeof registerMemoryFlushPlan !== "function"
        && typeof registerMemoryRuntime !== "function")
        return;
    const manager = createCompatMemorySearchManager({
        workspaceDir: resolveHostMemoryWorkspaceDir(api),
        provider: "clawlore",
        model: params.embeddingModel,
        dbPath: params.resolvedDbPath,
        pluginVersion: params.pluginVersion,
    });
    if (typeof registerMemoryPromptSection === "function") {
        registerMemoryPromptSection.call(api, buildCompatMemoryPromptSection);
    }
    if (typeof registerMemoryFlushPlan === "function") {
        registerMemoryFlushPlan.call(api, () => null);
    }
    if (typeof registerMemoryRuntime === "function") {
        registerMemoryRuntime.call(api, {
            async getMemorySearchManager() {
                return { manager };
            },
            resolveMemoryBackendConfig() {
                return { backend: "builtin" };
            },
            async closeAllMemorySearchManagers() { },
        });
    }
}
