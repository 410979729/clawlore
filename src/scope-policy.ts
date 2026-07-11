/**
 * Explicit scope policy helpers.
 *
 * Keeps Tianji's compatibility baseline (`agent:main` shared behavior) while
 * making project/channel/customer/task boundaries visible before broad
 * cross-scope auto-recall is trusted.
 */

export type ScopeDimensionKind =
  | "global"
  | "agent"
  | "project"
  | "channel"
  | "customer_host"
  | "task_class"
  | "custom"
  | "reflection"
  | "unknown";

export interface ScopeDimensions {
  raw: string;
  kind: ScopeDimensionKind;
  id: string;
  agent_id?: string;
  project_id?: string;
  channel_id?: string;
  customer_host?: string;
  task_class?: string;
}

export interface RuntimeScopeContext {
  agent_id?: string;
  project_id?: string;
  channel_id?: string;
  customer_host?: string;
  task_class?: string;
  scope_id?: string;
}

export interface ScopePolicyDecision {
  current_scope: string;
  candidate_scope: string;
  allowed: boolean;
  injectable: boolean;
  crossed_scope: boolean;
  label: "same_scope" | "global_shared" | "agent_shared" | "cross_scope_allowed" | "cross_scope_review";
  reason: string;
  current: ScopeDimensions;
  candidate: ScopeDimensions;
}

function cleanToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}:._-]+/gu, "")
    .slice(0, 120);
}

export function parseScopeDimensions(scope: unknown): ScopeDimensions {
  const raw = cleanToken(scope);
  if (!raw) return { raw: "", kind: "unknown", id: "" };
  if (raw === "global") return { raw, kind: "global", id: "global" };

  const [head, ...restParts] = raw.split(":");
  const rest = restParts.join(":");
  switch (head) {
    case "agent":
      return { raw, kind: "agent", id: rest, agent_id: rest };
    case "project":
      return { raw, kind: "project", id: rest, project_id: rest };
    case "reflection":
      return { raw, kind: "reflection", id: rest, agent_id: rest.replace(/^agent:/, "") };
    case "custom": {
      if (rest.startsWith("channel:")) {
        const channelId = rest.slice("channel:".length);
        return { raw, kind: "channel", id: channelId, channel_id: channelId };
      }
      if (rest.startsWith("customer:")) {
        const customerHost = rest.slice("customer:".length);
        return { raw, kind: "customer_host", id: customerHost, customer_host: customerHost };
      }
      if (rest.startsWith("task:")) {
        const taskClass = rest.slice("task:".length);
        return { raw, kind: "task_class", id: taskClass, task_class: taskClass };
      }
      return { raw, kind: "custom", id: rest };
    }
    default:
      return { raw, kind: "unknown", id: raw };
  }
}

export function scopeIdForContext(context: RuntimeScopeContext): string {
  if (context.scope_id && cleanToken(context.scope_id)) return cleanToken(context.scope_id);
  if (context.customer_host) return `custom:customer:${cleanToken(context.customer_host)}`;
  if (context.project_id) return `project:${cleanToken(context.project_id)}`;
  if (context.channel_id) return `custom:channel:${cleanToken(context.channel_id)}`;
  if (context.task_class) return `custom:task:${cleanToken(context.task_class)}`;
  if (context.agent_id) return `agent:${cleanToken(context.agent_id)}`;
  return "global";
}

function sameBoundary(current: ScopeDimensions, candidate: ScopeDimensions): boolean {
  return current.raw === candidate.raw ||
    (current.kind === "agent" && candidate.kind === "reflection" && current.agent_id === candidate.agent_id) ||
    (current.kind === "reflection" && candidate.kind === "agent" && current.agent_id === candidate.agent_id);
}

export function evaluateRecallScopePolicy(
  input: {
    current_scope: string;
    candidate_scope: string;
    allow_cross_scope?: boolean;
  },
): ScopePolicyDecision {
  const current = parseScopeDimensions(input.current_scope);
  const candidate = parseScopeDimensions(input.candidate_scope);

  if (sameBoundary(current, candidate)) {
    return {
      current_scope: current.raw,
      candidate_scope: candidate.raw,
      allowed: true,
      injectable: true,
      crossed_scope: false,
      label: "same_scope",
      reason: "candidate belongs to the current scope boundary",
      current,
      candidate,
    };
  }

  if (candidate.kind === "global") {
    return {
      current_scope: current.raw,
      candidate_scope: candidate.raw,
      allowed: true,
      injectable: true,
      crossed_scope: false,
      label: "global_shared",
      reason: "global scope remains the compatibility baseline",
      current,
      candidate,
    };
  }

  if (current.kind === "agent" && candidate.kind === "agent" && current.agent_id === candidate.agent_id) {
    return {
      current_scope: current.raw,
      candidate_scope: candidate.raw,
      allowed: true,
      injectable: true,
      crossed_scope: false,
      label: "agent_shared",
      reason: "same agent scope",
      current,
      candidate,
    };
  }

  const allowCrossScope = input.allow_cross_scope === true;
  return {
    current_scope: current.raw,
    candidate_scope: candidate.raw,
    allowed: allowCrossScope,
    injectable: allowCrossScope,
    crossed_scope: true,
    label: allowCrossScope ? "cross_scope_allowed" : "cross_scope_review",
    reason: allowCrossScope
      ? "cross-scope recall explicitly allowed"
      : "cross-scope recall requires explicit opt-in or operator review",
    current,
    candidate,
  };
}
