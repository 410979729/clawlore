export type StructuredToolOutcome = "success" | "failure";

export interface StructuredToolOutcomeSummary {
  resultCount: number;
  successCount: number;
  failureCount: number;
  lastOutcome: StructuredToolOutcome | null;
  resolvedFailureToolCount: number;
  unresolvedFailureToolCount: number;
}

const FAILURE_STATES = new Set([
  "aborted",
  "blocked",
  "cancelled",
  "canceled",
  "error",
  "failed",
  "failure",
  "incomplete",
  "partial",
  "rejected",
  "timeout",
  "timed_out",
  "unverified",
]);

const SUCCESS_STATES = new Set([
  "complete",
  "completed",
  "ok",
  "pass",
  "passed",
  "success",
  "succeeded",
  "verified",
]);

function normalizedState(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[ -]+/g, "_") : "";
}

function isToolResultMessage(message: unknown): message is Record<string, unknown> {
  if (!message || typeof message !== "object") return false;
  const obj = message as Record<string, unknown>;
  const role = normalizedState(obj.role ?? obj.type ?? obj.kind).replace(/_/g, "");
  if (role === "tool" || role === "function" || role === "toolresult") return true;
  // A user/assistant message can mention or carry a call id without being the
  // tool's result envelope. Never let a request-side success flag stand in for
  // an executed tool receipt.
  if (["user", "assistant", "system"].includes(role)) return false;
  return typeof obj.toolCallId === "string" || typeof obj.tool_call_id === "string";
}

function explicitOutcomeFromObject(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): StructuredToolOutcome | null {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    let sawSuccess = false;
    for (const item of value.slice(0, 100)) {
      const nested = explicitOutcomeFromObject(item, depth + 1, seen);
      if (nested === "failure") return "failure";
      if (nested === "success") sawSuccess = true;
    }
    return sawSuccess ? "success" : null;
  }
  const obj = value as Record<string, unknown>;
  const explicitError = obj.error;
  const explicitErrors = obj.errors;
  let sawFailure = obj.isError === true
    || obj.success === false
    || obj.ok === false
    || (typeof explicitError === "string" && Boolean(explicitError.trim()))
    || explicitError === true
    || (typeof explicitError === "object" && explicitError !== null)
    || (Array.isArray(explicitErrors) && explicitErrors.length > 0)
    || (typeof explicitErrors === "string" && Boolean(explicitErrors.trim()));
  let sawSuccess = obj.isError === false || obj.success === true || obj.ok === true;

  for (const key of ["status", "outcome", "state"]) {
    const state = normalizedState(obj[key]);
    if (FAILURE_STATES.has(state)) sawFailure = true;
    if (SUCCESS_STATES.has(state)) sawSuccess = true;
  }
  for (const key of ["exitCode", "exit_code"]) {
    if (typeof obj[key] === "number" && Number.isInteger(obj[key])) {
      if (obj[key] === 0) sawSuccess = true;
      else sawFailure = true;
    }
  }
  for (const key of ["statusCode", "status_code", "httpStatus", "http_status"]) {
    const code = obj[key];
    if (typeof code === "number" && Number.isInteger(code)) {
      if (code >= 200 && code < 300) sawSuccess = true;
      else if (code >= 400) sawFailure = true;
    }
  }
  if (typeof obj.code === "number" && Number.isInteger(obj.code)) {
    if (obj.code === 0 || (obj.code >= 200 && obj.code < 300)) sawSuccess = true;
    else if ((obj.code > 0 && obj.code < 100) || obj.code >= 400) sawFailure = true;
  }
  for (const key of ["details", "result", "results", "metadata", "data", "output", "response", "receipt", "receipts"]) {
    const nested = explicitOutcomeFromObject(obj[key], depth + 1, seen);
    if (nested === "failure") sawFailure = true;
    if (nested === "success") sawSuccess = true;
  }

  // A contradictory envelope is unsafe evidence. Failure must dominate even
  // when a wrapper optimistically sets success=true around a failed result.
  if (sawFailure) return "failure";
  return sawSuccess ? "success" : null;
}

/**
 * Read only explicit tool-result fields. Free-form stdout is deliberately not
 * promoted into success evidence because a zero-looking string can be stale,
 * quoted, or unrelated to the actual tool envelope.
 */
export function structuredToolOutcome(message: unknown): StructuredToolOutcome | null {
  if (!isToolResultMessage(message)) return null;
  return explicitOutcomeFromObject(message);
}

export function summarizeStructuredToolOutcomes(messages: unknown[]): StructuredToolOutcomeSummary {
  let resultCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let lastOutcome: StructuredToolOutcome | null = null;
  const latestByTool = new Map<string, StructuredToolOutcome>();
  const toolsWithFailure = new Set<string>();
  for (const [index, message] of (Array.isArray(messages) ? messages : []).entries()) {
    const outcome = structuredToolOutcome(message);
    if (!outcome) continue;
    resultCount++;
    if (outcome === "success") successCount++;
    else failureCount++;
    lastOutcome = outcome;
    const obj = message && typeof message === "object" ? message as Record<string, unknown> : {};
    const explicitName = normalizedState(obj.toolName ?? obj.tool_name ?? obj.name ?? obj.functionName ?? obj.function_name);
    const toolKey = explicitName || `unresolved-tool-result:${index}`;
    latestByTool.set(toolKey, outcome);
    if (outcome === "failure") toolsWithFailure.add(toolKey);
  }
  let resolvedFailureToolCount = 0;
  let unresolvedFailureToolCount = 0;
  for (const toolKey of toolsWithFailure) {
    if (latestByTool.get(toolKey) === "success") resolvedFailureToolCount++;
    else unresolvedFailureToolCount++;
  }
  return {
    resultCount,
    successCount,
    failureCount,
    lastOutcome,
    resolvedFailureToolCount,
    unresolvedFailureToolCount,
  };
}

/** The typed OpenClaw agent_end event always carries an explicit success bit. */
export function agentEndEventAllowsTaskExperience(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const obj = event as Record<string, unknown>;
  if (obj.success !== true) return false;
  if (
    obj.error === true
    || (typeof obj.error === "string" && obj.error.trim())
    || (typeof obj.error === "object" && obj.error !== null)
    || (Array.isArray(obj.errors) && obj.errors.length > 0)
    || (typeof obj.errors === "string" && obj.errors.trim())
  ) return false;
  for (const key of ["status", "outcome"]) {
    if (FAILURE_STATES.has(normalizedState(obj[key]))) return false;
  }
  return true;
}

const PROTECTIVE_SUBJECT = /\b(?:unauthorized|unauthenticated|untrusted|unprivileged|non[- ]?admin)\s+(?:users?|accounts?|clients?|callers?|requests?)\b|(?:未授权|未经授权|无权限|非管理员|不受信任)(?:的)?(?:用户|账户|客户端|调用方|请求)/giu;

const CAPABILITY_DENIAL = /\b(?:cannot|can't|can\s+not|unable\s+to|not\s+able\s+to)\s+(?:access|write|read|delete|modify|invoke|connect)\b|\b(?:has|have|had)\s+(?:still\s+)?no\s+(?:[a-z0-9_-]+\s+){0,5}?(?:access|permissions?|connectivity)\b|\b(?:lacks?|lacked|without)\s+(?:[a-z0-9_-]+\s+){0,4}?(?:access|permissions?)\b|\b(?:is|are|was|were|remains?)\s+(?:still\s+)?(?:locked\s+out|denied\s+access)\b|\b(?:receives?|gets?)\s+(?:an?\s+)?(?:403|forbidden|unauthorized)\b|(?:不能|无法|不可)(?:访问|读取|写入|删除|修改|调用|连接)|(?:没有|无)(?:[^，。；,.!?！？]{0,12})(?:访问权限|读取权限|写入权限|管理端权限|连接权限)|(?:被拒绝访问|被锁定在外)/giu;

function sentenceStart(value: string, offset: number): number {
  let boundary = -1;
  for (const delimiter of [".", "!", "?", ";", ",", "。", "！", "？", "；", "，", "\n"]) {
    boundary = Math.max(boundary, value.lastIndexOf(delimiter, Math.max(0, offset - 1)));
  }
  return boundary + 1;
}

function stripSubjectNoise(value: string): string {
  return value
    .replace(PROTECTIVE_SUBJECT, " ")
    .replace(/\b(?:and|or|nor|plus|while|whereas|but|yet|as\s+well\s+as|also|still|likewise|again|then|therefore|either|neither|by\s+design|under\s+no\s+circumstances)\b/giu, " ")
    .replace(/(?:以及|加上|并且|而且|同时|而|且|也|仍|仍然|依然|同样|还|再次|绝不|按设计|在任何情况下都不)/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Classify each denial by its nearest subject. A denial is protective only
 * when the clause explicitly binds it to an unauthorized actor; later clauses
 * inherit that subject solely when they contain connector/adverb noise and no
 * new substantive subject.
 */
function hasNonProtectiveCapabilityDenial(value: string): boolean {
  const matches = [...value.matchAll(CAPABILITY_DENIAL)];
  let previousEnd = -1;
  let previousProtective = false;
  for (const match of matches) {
    const start = match.index ?? 0;
    const boundary = sentenceStart(value, start);
    const sameClauseChain = previousEnd >= boundary;
    const subjectSlice = value.slice(sameClauseChain ? previousEnd : boundary, start);
    PROTECTIVE_SUBJECT.lastIndex = 0;
    const hasProtectiveSubject = PROTECTIVE_SUBJECT.test(subjectSlice);
    PROTECTIVE_SUBJECT.lastIndex = 0;
    const hasSubstantiveSubject = stripSubjectNoise(subjectSlice).length > 0;
    const protective: boolean = hasProtectiveSubject && !hasSubstantiveSubject
      ? true
      : !hasSubstantiveSubject && sameClauseChain
        ? previousProtective
        : false;
    if (!protective) return true;
    previousProtective = protective;
    previousEnd = start + match[0].length;
  }

  const inheritedDenial = /\bneither\s+(?:can|could|do|does|did|have|has)\s+([^,;.!?]{1,80})/giu;
  for (const match of value.matchAll(inheritedDenial)) {
    const subject = match[1] ?? "";
    PROTECTIVE_SUBJECT.lastIndex = 0;
    const protective = PROTECTIVE_SUBJECT.test(subject) && stripSubjectNoise(subject).length === 0;
    PROTECTIVE_SUBJECT.lastIndex = 0;
    if (!protective) return true;
  }
  return false;
}

export function finalAssistantClaimsVerifiedSuccess(text: string): boolean {
  const final = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!final) return false;
  const completion = /\b(?:completed|finished|fixed|repaired|resolved|deployed|restored|successful(?:ly)?|succeeded)\b|(?:已完成|完成|修复完成|修复成功|解决完成|部署完成|已部署|恢复正常|成功)/u.test(final);
  const verification = /\b(?:verified|validated|confirmed|(?:tests?|checks?|audits?|probes?)\b.{0,32}\bpass(?:ed)?|health\s*(?:check|probe)\b.{0,20}\bpass(?:ed)?)\b|(?:验证通过|测试通过|检查通过|健康检查通过|探针通过|已验证|确认通过|运行正常)/u.test(final);
  return completion && verification;
}

export function finalAssistantLooksUnsuccessful(text: string): boolean {
  const final = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!final) return false;
  if (hasNonProtectiveCapabilityDenial(final)) return true;

  const positive = [
    /\b(?:completed|finished|fixed|repaired|resolved|deployed|restored|verified|validated|passed|healthy|successful(?:ly)?)\b/g,
    /(?:已完成|完成并验证|修复完成|修复成功|验证通过|测试通过|部署完成|已部署|恢复正常|运行正常|健康检查通过|成功)/gu,
  ];
  const negative = [
    /\b(?:not|never)\s+(?:completed|finished|fixed|repaired|resolved|deployed|verified|validated)\b/g,
    /\b(?:cannot|can't|unable\s+to|not\s+able\s+to)\s+(?:complete|finish|fix|repair|resolve|deploy|verify|validate|confirm|start|restart|run|test)\b/g,
    /\b(?:task|deployment|repair|fix|verification|validation|tests?|health\s*check|probe|service)\b.{0,24}\b(?:blocked|failed|failing|incomplete|unverified)\b/g,
    /\b(?:failed|failure|blocked|unverified)\s*[.!?]*$/g,
    /\b(?:did|does|do|has|have|is|are|was|were)\s+not\s+(?:succeed(?:ed)?|work(?:ing)?|pass(?:ed)?|healthy|available|reachable)\b/g,
    /\b(?:remains?|still)\s+(?:broken|failing|unhealthy|unavailable|unreachable|incomplete|unverified)\b/g,
    /\b(?:tests?|checks?|probes?)\b.{0,24}\b(?:reported?|returned?|found)\b.{0,20}\b(?:errors?|failures?)\b/g,
    /(?:未|没|没有)(?:完成|修复|解决|部署|(?:验证|测试)(?:通过)?|确认(?:成功)?|通过)/gu,
    /(?:无法|不能)(?:完成|修复|解决|部署|验证|确认(?:成功)?|启动|重启|运行|测试)/gu,
    /(?:任务|部署|修复|验证|测试|健康检查|探针|服务).{0,12}(?:失败|阻塞|未完成|未通过|仍在报错)/gu,
    /(?:仍|依然|还是).{0,12}(?:失败|报错|未通过|未完成)/gu,
    /(?:仍|依然|还是).{0,12}(?:不可用|不健康|无法访问|未恢复)/gu,
    /(?:失败|阻塞|未验证|报错)[。！？.!?]*$/gu,
  ];
  const lastMatchEnd = (patterns: RegExp[]): number => {
    let last = -1;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of final.matchAll(pattern)) {
        last = Math.max(last, (match.index ?? 0) + match[0].length);
      }
    }
    return last;
  };
  const lastNegative = lastMatchEnd(negative);
  if (lastNegative < 0) return false;

  // Historical failures may be reported as evidence of a completed repair,
  // but only when the wording explicitly orders the old failure before a
  // later verified resolution. A current statement such as "not completed,
  // but checks passed" remains unsuccessful regardless of trailing positives.
  const resolvedHistoricalFailure = /\b(?:first|initial|earlier|previous)\b.{0,80}\b(?:failed|failing|blocked|incomplete|errored|unhealthy|unavailable)\b.{0,120}\b(?:then|after(?:wards)?|subsequently|later)\b.{0,120}\b(?:completed|fixed|repaired|resolved|restored)\b.{0,100}\b(?:passed|verified|validated|healthy)\b/u.test(final)
    || /(?:最初|起初|此前|先前|第一次).{0,40}(?:失败|报错|阻塞|未完成|不可用|不健康).{0,80}(?:随后|后来|之后|修复后).{0,80}(?:完成|修复|解决|恢复).{0,60}(?:验证通过|测试通过|检查通过|运行正常)/u.test(final);
  return !resolvedHistoricalFailure || lastMatchEnd(positive) <= lastNegative;
}
