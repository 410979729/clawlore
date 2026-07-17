import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";

type AgentWorkspaceMap = Record<string, string>;

export type MarkdownMirrorWriter = (
  entry: { text: string; category: string; scope: string; timestamp?: number },
  meta?: { source?: string; agentId?: string },
) => Promise<void>;

function resolveAgentWorkspaceMap(api: OpenClawPluginApi): AgentWorkspaceMap {
  const map: AgentWorkspaceMap = {};
  const agents = Array.isArray((api as any).config?.agents?.list)
    ? (api as any).config.agents.list
    : [];
  for (const agent of agents) {
    if (agent?.id && typeof agent.workspace === "string") map[String(agent.id)] = agent.workspace;
  }

  if (Object.keys(map).length === 0) {
    try {
      const openclawHome = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
      const parsed = JSON.parse(readFileSync(join(openclawHome, "openclaw.json"), "utf8"));
      const list = parsed?.agents?.list;
      if (Array.isArray(list)) {
        for (const agent of list) {
          if (agent?.id && typeof agent.workspace === "string") {
            map[String(agent.id)] = agent.workspace;
          }
        }
      }
    } catch {
      // Missing or malformed fallback config leaves the explicit fallback directory in control.
    }
  }
  return map;
}

/** Creates the optional Markdown projection writer; SQL remains the authority. */
export function createMdMirrorWriter(
  api: OpenClawPluginApi,
  config: { enabled?: boolean; dir?: string } | undefined,
  resolvedDbPath: string,
  summarizeError: (error: unknown) => string,
): MarkdownMirrorWriter | null {
  if (config?.enabled !== true) return null;
  const fallbackDir = config.dir
    ? api.resolvePath(config.dir)
    : join(dirname(resolvedDbPath), "memory-md");
  const workspaceMap = resolveAgentWorkspaceMap(api);
  if (Object.keys(workspaceMap).length > 0) {
    api.logger.info(`mdMirror: resolved ${Object.keys(workspaceMap).length} agent workspace(s)`);
  } else {
    api.logger.warn(`mdMirror: no agent workspaces found, writes will use fallback dir: ${fallbackDir}`);
  }

  return async (entry, meta) => {
    try {
      const ts = new Date(entry.timestamp || Date.now());
      const mirrorDir = meta?.agentId && workspaceMap[meta.agentId]
        ? join(workspaceMap[meta.agentId], "memory")
        : fallbackDir;
      const filePath = join(mirrorDir, `${ts.toISOString().split("T")[0]}.md`);
      const agentLabel = meta?.agentId ? ` agent=${meta.agentId}` : "";
      const sourceLabel = meta?.source ? ` source=${meta.source}` : "";
      const safeText = entry.text.replace(/\n/g, " ").slice(0, 500);
      const line = `- ${ts.toISOString()} [${entry.category}:${entry.scope}]${agentLabel}${sourceLabel} ${safeText}\n`;
      await mkdir(mirrorDir, { recursive: true });
      await appendFile(filePath, line, "utf8");
    } catch (error) {
      api.logger.warn(`mdMirror: write failed: ${summarizeError(error)}`);
    }
  };
}
