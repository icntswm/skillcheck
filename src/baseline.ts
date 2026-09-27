import type { CaseReport, SuiteReport } from "./results.js";

export type Change = "regressed" | "fixed" | "new";

export interface BaselineSummary {
  file: string;
  regressed: number;
  fixed: number;
  /** cases the baseline has no result for: not there, or skipped by its budget */
  new: number;
  /** baseline cases no longer in the cases file */
  removed: number;
}

const STATUSES = ["passed", "failed", "skipped"];

/** Parse a --json report; checked up front so a bad file fails before any model call. */
export function parseBaseline(text: string): SuiteReport {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || (value as { tool?: unknown }).tool !== "skillcheck" || !Array.isArray((value as { cases?: unknown }).cases)) {
    throw new Error("not a skillcheck --json report");
  }
  (value as { cases: unknown[] }).cases.forEach((c, i) => {
    const entry = c as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || typeof entry.query !== "string" || !STATUSES.includes(entry.status as string) ||
      (entry.id !== null && typeof entry.id !== "string")) {
      throw new Error(`case ${i + 1} is not a report case (needs query, id and status passed, failed or skipped)`);
    }
  });
  return value as SuiteReport;
}

/**
 * Compare current cases with a previous report. suite is every case of the cases file, so cases
 * left out by --only or --skill do not count as removed.
 */
export function compare(
  current: CaseReport[],
  baseline: SuiteReport,
  file: string,
  suite: CaseKey[] = current,
): { changes: (Change | null)[]; summary: BaselineSummary } {
  const previous = new Map<string, CaseReport>();
  for (const c of baseline.cases) {
    const key = caseKey(c);
    if (!previous.has(key)) previous.set(key, c);
  }
  let regressed = 0;
  let fixed = 0;
  let newCount = 0;
  const changes = current.map((c) => {
    const old = previous.get(caseKey(c));
    if (c.status === "skipped") return null;
    // a case the baseline budget skipped has no result to compare with
    if (old === undefined || old.status === "skipped") {
      newCount++;
      return "new" as const;
    }
    if (old.status === "passed" && c.status === "failed") {
      regressed++;
      return "regressed" as const;
    }
    if (old.status === "failed" && c.status === "passed") {
      fixed++;
      return "fixed" as const;
    }
    return null;
  });
  const suiteKeys = new Set(suite.map(caseKey));
  let removed = 0;
  for (const key of previous.keys()) if (!suiteKeys.has(key)) removed++;
  return { changes, summary: { file, regressed, fixed, new: newCount, removed } };
}

type CaseKey = Pick<CaseReport, "id" | "query">;

function caseKey(c: CaseKey): string {
  return c.id !== null ? `id:${c.id}` : `query:${c.query}`;
}
