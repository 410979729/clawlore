export interface TaskExperienceCapsuleFields {
  taskType: string;
  triggerPhrases: string[];
  applicability: string[];
  preconditions: string[];
  steps: string[];
  verification: string[];
  failureSignals: string[];
  safetyBoundaries: string[];
  cleanup: string[];
  evidenceRequired: string[];
}

interface CapsuleSection {
  title: string;
  items: string[];
  numbered?: boolean;
}

const MIN_SECTION_BUDGET = 36;

function truncate(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function allocate(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  let remainder = Math.max(0, total - (base * count));
  return Array.from({ length: count }, () => base + (remainder-- > 0 ? 1 : 0));
}

function renderSection(section: CapsuleSection, budget: number): string {
  if (budget <= 0) return "";
  const heading = `${section.title}:`;
  if (budget <= heading.length) return truncate(heading, budget);
  const items = section.items.length > 0 ? section.items : ["(none)"];
  let output = heading;
  for (let index = 0; index < items.length; index++) {
    const prefix = section.numbered ? `${index + 1}. ` : "- ";
    const available = budget - output.length - 1;
    if (available <= prefix.length) break;
    const line = `${prefix}${items[index]}`;
    output += `\n${truncate(line, available)}`;
    if (output.length >= budget) break;
  }
  return output;
}

/**
 * Build a bounded capsule without slicing one monolithic string. Safety and
 * verification fields receive their own budgets and are placed first so a
 * downstream recall limit cannot retain the procedure while dropping every
 * stop, verification, cleanup, and evidence condition.
 */
export function formatTaskExperienceCapsule(
  fields: TaskExperienceCapsuleFields,
  maxChars: number,
): string {
  const boundedMax = Math.max(0, Math.floor(maxChars));
  if (boundedMax === 0) return "";
  const header = truncate(`Reusable Task Experience: ${fields.taskType}`, Math.min(boundedMax, 220));
  const critical: CapsuleSection[] = [
    { title: "Verification Gate", items: fields.verification },
    { title: "Failure Signals", items: fields.failureSignals },
    { title: "Safety Boundaries", items: fields.safetyBoundaries },
    { title: "Cleanup", items: fields.cleanup },
    { title: "Evidence Required Before Reporting Success", items: fields.evidenceRequired },
  ];
  const context: CapsuleSection[] = [
    { title: "Trigger Phrases", items: fields.triggerPhrases },
    { title: "When To Apply", items: fields.applicability },
    { title: "Preconditions", items: fields.preconditions },
    { title: "Procedure", items: fields.steps, numbered: true },
  ];
  const separatorChars = 2 * (critical.length + context.length);
  const available = Math.max(0, boundedMax - header.length - separatorChars);
  const minimumCritical = MIN_SECTION_BUDGET * critical.length;
  const criticalTotal = Math.min(
    available,
    Math.max(minimumCritical, Math.floor(available * 0.62)),
  );
  const contextTotal = Math.max(0, available - criticalTotal);
  const criticalBudgets = allocate(criticalTotal, critical.length);
  const contextBudgets = allocate(contextTotal, context.length);
  const sections = [
    ...critical.map((section, index) => renderSection(section, criticalBudgets[index] ?? 0)),
    ...context.map((section, index) => renderSection(section, contextBudgets[index] ?? 0)),
  ].filter(Boolean);
  return truncate([header, ...sections].join("\n\n"), boundedMax);
}

function metadataFields(metadata: Record<string, unknown>): TaskExperienceCapsuleFields | null {
  const taskType = typeof metadata.task_type === "string" ? metadata.task_type.trim() : "";
  const structuredKeys = [
    "trigger_phrases",
    "applicability",
    "preconditions",
    "procedure_steps",
    "verification_gate",
    "failure_signals",
    "safety_boundaries",
    "cleanup",
    "evidence_required",
  ];
  if (!taskType || !structuredKeys.some((key) => Array.isArray(metadata[key]))) return null;
  return {
    taskType,
    triggerPhrases: stringList(metadata.trigger_phrases),
    applicability: stringList(metadata.applicability),
    preconditions: stringList(metadata.preconditions),
    steps: stringList(metadata.procedure_steps),
    verification: stringList(metadata.verification_gate),
    failureSignals: stringList(metadata.failure_signals),
    safetyBoundaries: stringList(metadata.safety_boundaries),
    cleanup: stringList(metadata.cleanup),
    evidenceRequired: stringList(metadata.evidence_required),
  };
}

export function formatTaskExperienceRecallCapsule(
  metadata: Record<string, unknown>,
  fallbackText: string,
  maxChars: number,
): string {
  const fields = metadataFields(metadata);
  return fields
    ? formatTaskExperienceCapsule(fields, maxChars)
    : truncate(fallbackText, Math.max(0, Math.floor(maxChars)));
}
