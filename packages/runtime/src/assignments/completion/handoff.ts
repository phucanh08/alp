export const HANDOFF_OUTCOMES = ['complete', 'partial', 'blocked', 'reconsider'] as const;
export const HANDOFF_LISTS = ['candidate', 'scope', 'verification', 'risks', 'discovered'] as const;

/**
 * A review's verdict (ALPD §38): each criterion judged with its evidence, findings
 * by severity, and one result that follows from them, so requesters, tasks and
 * later a review quorum read every review the same way.
 */
export const VERDICT_RESULTS = ['pass', 'pass_with_findings', 'fail', 'blocked'] as const;
export const CRITERION_RESULTS = ['pass', 'fail', 'not_checked'] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Verdict = {
  result: typeof VERDICT_RESULTS[number];
  criteria: Array<{ criterion: string; result: typeof CRITERION_RESULTS[number]; evidence: string }>;
  findings?: Array<{ severity: typeof SEVERITIES[number]; where: string; problem: string; fix?: string }>;
};

export type Handoff = {
  outcome: typeof HANDOFF_OUTCOMES[number];
  summary: string;
  ownership?: string;
  verdict?: Verdict;
} & Partial<Record<typeof HANDOFF_LISTS[number], string[]>>;

/** Returns the normalized handoff, or an error message for the child. */
/** Returns the verdict, or what is wrong with it; its result must follow from its criteria and findings. */
export function parseVerdict(value: any): Verdict | string {
  const text = (item: unknown) => typeof item === 'string' && !!item.trim();
  const only = (item: any, keys: string[]) => !!item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).every(key => keys.includes(key));
  if (!only(value, ['result', 'criteria', 'findings'])) return 'verdict must be an object with result, criteria and findings';
  if (!VERDICT_RESULTS.includes(value.result)) return `verdict.result must be one of ${VERDICT_RESULTS.join(', ')}`;
  if (!Array.isArray(value.criteria) || !value.criteria.length || value.criteria.length > 50) return 'verdict.criteria must list 1 to 50 criteria';
  for (const item of value.criteria) {
    if (!only(item, ['criterion', 'result', 'evidence']) || !text(item.criterion) || !text(item.evidence) || !CRITERION_RESULTS.includes(item.result)) {
      return `each verdict criterion needs criterion, result (${CRITERION_RESULTS.join(', ')}) and evidence`;
    }
  }
  const findings = value.findings ?? [];
  if (!Array.isArray(findings) || findings.length > 100) return 'verdict.findings must be a list of at most 100 findings';
  for (const item of findings) {
    if (!only(item, ['severity', 'where', 'problem', 'fix']) || !SEVERITIES.includes(item.severity) || !text(item.where) || !text(item.problem) || (item.fix !== undefined && !text(item.fix))) {
      return `each verdict finding needs severity (${SEVERITIES.join(', ')}), where and problem, and optionally fix`;
    }
  }
  const failed = value.criteria.filter((item: any) => item.result === 'fail').length;
  const serious = findings.filter((item: any) => item.severity === 'critical' || item.severity === 'high').length;
  if (value.result === 'fail' && !failed && !serious) return 'verdict fail needs a failed criterion or a critical or high finding';
  if ((value.result === 'pass' || value.result === 'pass_with_findings') && (failed || serious)) {
    return `verdict ${value.result} cannot have ${failed ? 'a failed criterion' : 'a critical or high finding'}; the result is fail`;
  }
  if (value.result === 'pass' && findings.length) return 'verdict pass cannot have findings; use pass_with_findings';
  if (value.result === 'pass_with_findings' && !findings.length) return 'verdict pass_with_findings needs findings';
  return { result: value.result, criteria: value.criteria, ...(findings.length ? { findings } : {}) };
}

/** A verdict in one line: its result and the criteria counts. */
export function verdictLine(verdict: Verdict) {
  const count = (result: string) => verdict.criteria.filter(item => item.result === result).length;
  const parts = [`${count('pass')} passed`, count('fail') ? `${count('fail')} failed` : '', count('not_checked') ? `${count('not_checked')} not checked` : '', verdict.findings?.length ? `${verdict.findings.length} findings` : ''];
  return `verdict ${verdict.result.toUpperCase()} (${parts.filter(Boolean).join(', ')})`;
}

export function parseHandoff(args: any): Handoff | string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Handoff must be an object';
  const allowed = ['outcome', 'summary', 'ownership', 'verdict', ...HANDOFF_LISTS];
  if (Object.keys(args).some(key => !allowed.includes(key))) return 'Unknown handoff field';
  if (!HANDOFF_OUTCOMES.includes(args.outcome)) return `outcome must be one of ${HANDOFF_OUTCOMES.join(', ')}`;
  if (typeof args.summary !== 'string' || !args.summary.trim()) return 'summary is required';
  if (args.ownership !== undefined && typeof args.ownership !== 'string') return 'ownership must be a string';
  const handoff: Handoff = { outcome: args.outcome, summary: args.summary };
  for (const key of HANDOFF_LISTS) {
    if (args[key] === undefined) continue;
    if (!Array.isArray(args[key]) || args[key].length > 100 || !args[key].every((item: unknown) => typeof item === 'string' && item.trim())) {
      return `${key} must be a list of at most 100 nonempty strings`;
    }
    handoff[key] = args[key];
  }
  if (args.ownership?.trim()) handoff.ownership = args.ownership;
  if (args.verdict !== undefined) {
    const verdict = parseVerdict(args.verdict);
    if (typeof verdict === 'string') return verdict;
    handoff.verdict = verdict;
  }
  if (JSON.stringify(handoff).length > 32_000) return 'Handoff exceeds 32000 characters; summarize and point to files instead';
  return handoff;
}
