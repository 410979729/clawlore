/**
 * Experience Kernel - Data Models and Validation
 *
 * Ported from Hermes scope-recall experience_models.py
 */

export const CAPABILITY_CLASSES = new Set([
  "read_only",
  "local_write",
  "service_control",
  "network_or_remote",
  "cross_instance",
  "credential_adjacent",
  "destructive_or_irreversible",
]);

export const RISKY_CAPABILITY_CLASSES = new Set([
  "service_control",
  "network_or_remote",
  "cross_instance",
  "credential_adjacent",
  "destructive_or_irreversible",
]);

export const PLAYBOOK_STATUSES = new Set([
  "candidate",
  "reviewed",
  "promoted",
  "needs_review",
  "superseded",
  "quarantined",
]);

export const PLAYBOOK_SCHEMA_VERSION = "procedural_playbook.v1";

export class ExperienceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperienceValidationError";
  }
}

export interface PlaybookStep {
  number: number;
  capability_class: string;
  action: string;
  evidence_required: string;
  why?: string;
  previous_mistakes?: string[];
}

export interface ProceduralPlaybook {
  schema_version: string;
  task_class: string;
  title: string;
  trigger: string;
  goal: string;
  preconditions: Record<string, unknown>[];
  steps: PlaybookStep[];
  pitfalls: Record<string, unknown>[];
  verification: string[];
  cleanup: string[];
  reuse_policy: Record<string, unknown>;
  status: string;
  confidence: number;
  requires_operator_review: boolean;
}

export interface TaskEpisode {
  id: string;
  scope_id: string;
  shared_scope_id: string;
  session_id: string;
  task_class: string;
  task_goal: string;
  user_intent: string;
  status: "open" | "completed" | "failed" | "abandoned";
  outcome: "success" | "failure" | "partial" | "unknown";
  started_at: string;
  ended_at: string | null;
  message_ids: string[];
  journal_entry_ids: string[];
  tool_names: string[];
  evidence: string[];
  verification: string[];
  environment: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ExperienceRun {
  id: string;
  playbook_id: string;
  episode_id: string;
  scope_id: string;
  decision: "used" | "skipped" | "failed";
  confidence_at_use: number;
  preconditions_checked: string[];
  steps_completed: number[];
  evidence: string[];
  outcome: "success" | "failure" | "partial" | "unknown";
  outcome_reason: string;
  model_name: string;
  tool_call_count: number;
  token_estimate: number;
  started_at: string;
  finished_at: string | null;
  metadata: Record<string, unknown>;
}

function requireText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ExperienceValidationError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function requireList(payload: Record<string, unknown>, key: string): unknown[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new ExperienceValidationError(`${key} must be a list`);
  }
  return value;
}

function textTuple(values: unknown[], fieldName: string): string[] {
  const normalized: string[] = [];
  for (let idx = 0; idx < values.length; idx++) {
    const value = values[idx];
    if (typeof value !== "string" || !value.trim()) {
      throw new ExperienceValidationError(`${fieldName}[${idx + 1}] must be a non-empty string`);
    }
    normalized.push(value.trim());
  }
  return normalized;
}

function mappingTuple(values: unknown[], fieldName: string): Record<string, unknown>[] {
  const normalized: Record<string, unknown>[] = [];
  for (let idx = 0; idx < values.length; idx++) {
    const value = values[idx];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ExperienceValidationError(`${fieldName}[${idx + 1}] must be an object`);
    }
    normalized.push(value as Record<string, unknown>);
  }
  return normalized;
}

function validateSteps(values: unknown[]): PlaybookStep[] {
  const steps: PlaybookStep[] = [];
  let expectedNumber = 1;

  for (let idx = 0; idx < values.length; idx++) {
    const value = values[idx];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ExperienceValidationError(`steps[${idx + 1}] must be an object`);
    }

    const step = value as Record<string, unknown>;
    const rawNumber = step.number;

    if (typeof rawNumber !== "number" || rawNumber !== expectedNumber) {
      throw new ExperienceValidationError(`steps[${idx + 1}].number must be ${expectedNumber}`);
    }

    const capabilityClass = step.capability_class;
    if (typeof capabilityClass !== "string" || !CAPABILITY_CLASSES.has(capabilityClass)) {
      throw new ExperienceValidationError(
        `steps[${idx + 1}].capability_class must be one of ${[...CAPABILITY_CLASSES].sort().join(", ")}`
      );
    }

    const action = step.action;
    if (typeof action !== "string" || !action.trim()) {
      throw new ExperienceValidationError(`steps[${idx + 1}].action must be a non-empty string`);
    }

    const evidenceRequired = step.evidence_required;
    if (typeof evidenceRequired !== "string" || !evidenceRequired.trim()) {
      throw new ExperienceValidationError(`steps[${idx + 1}].evidence_required must be a non-empty string`);
    }

    const previousMistakes = step.previous_mistakes ?? [];
    if (!Array.isArray(previousMistakes)) {
      throw new ExperienceValidationError(`steps[${idx + 1}].previous_mistakes must be a list`);
    }

    steps.push({
      number: rawNumber,
      capability_class: capabilityClass,
      action: action.trim(),
      evidence_required: evidenceRequired.trim(),
      why: typeof step.why === "string" ? step.why.trim() : "",
      previous_mistakes: textTuple(previousMistakes, `steps[${idx + 1}].previous_mistakes`),
    });

    expectedNumber++;
  }

  if (steps.length === 0) {
    throw new ExperienceValidationError("steps must contain at least one step");
  }

  return steps;
}

export function validateProceduralPlaybook(payload: Record<string, unknown>): ProceduralPlaybook {
  const schemaVersion = (payload.schema_version as string) || PLAYBOOK_SCHEMA_VERSION;
  if (schemaVersion !== PLAYBOOK_SCHEMA_VERSION) {
    throw new ExperienceValidationError(`schema_version must be ${PLAYBOOK_SCHEMA_VERSION}`);
  }

  const taskClass = requireText(payload, "task_class");
  const title = requireText(payload, "title");
  const trigger = requireText(payload, "trigger");
  const goal = requireText(payload, "goal");
  const preconditions = mappingTuple(requireList(payload, "preconditions"), "preconditions");

  if (preconditions.length === 0) {
    throw new ExperienceValidationError("preconditions must contain at least one item");
  }

  const steps = validateSteps(requireList(payload, "steps"));
  const pitfalls = mappingTuple((payload.pitfalls as unknown[]) ?? [], "pitfalls");
  const verification = textTuple(requireList(payload, "verification"), "verification");

  if (verification.length === 0) {
    throw new ExperienceValidationError("verification must contain at least one item");
  }

  const cleanup = textTuple((payload.cleanup as unknown[]) ?? [], "cleanup");

  const reusePolicy = payload.reuse_policy;
  if (typeof reusePolicy !== "object" || reusePolicy === null || Array.isArray(reusePolicy)) {
    throw new ExperienceValidationError("reuse_policy must be an object");
  }

  const status = String(payload.status ?? "candidate").trim();
  if (!PLAYBOOK_STATUSES.has(status)) {
    throw new ExperienceValidationError(`status must be one of ${[...PLAYBOOK_STATUSES].sort().join(", ")}`);
  }

  let confidence: number;
  try {
    confidence = Number(payload.confidence ?? 0.5);
  } catch {
    throw new ExperienceValidationError("confidence must be numeric");
  }

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ExperienceValidationError("confidence must be between 0.0 and 1.0");
  }

  const requiresOperatorReview =
    status !== "promoted" || steps.some((step) => RISKY_CAPABILITY_CLASSES.has(step.capability_class));

  return {
    schema_version: schemaVersion,
    task_class: taskClass,
    title,
    trigger,
    goal,
    preconditions,
    steps,
    pitfalls,
    verification,
    cleanup,
    reuse_policy: reusePolicy as Record<string, unknown>,
    status,
    confidence,
    requires_operator_review: requiresOperatorReview,
  };
}
