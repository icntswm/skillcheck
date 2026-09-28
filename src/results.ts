import type { Case } from "./cases.js";
import type { ConfusionPair } from "./confusion.js";
import type { CaseResult, RunVerdict } from "./judge.js";
import { compare, type BaselineSummary, type Change } from "./baseline.js";
import { readVersion } from "./version.js";

export interface SuiteReport {
  tool: "skillcheck";
  version: string;
  file: string;
  agent: string;
  model: string | null;
  /** batch mode: the model stated its choices instead of making them */
  batch: boolean;
  /** ISO 8601, when the run started */
  startedAt: string;
  durationMs: number;
  summary: {
    cases: number;
    failed: number;
    skipped: number;
    /** runs made, including those of cases the budget then skipped */
    runs: number;
    costUsd: number;
    unknownCostRuns: number;
    /** costUsd plus an estimate for the unknown-cost runs */
    estimatedCostUsd: number;
    diagnoses: number;
    budgetUsd: number | null;
    budgetReached: boolean;
    cached?: number;
    savedUsd?: number;
  };
  unavailable: string[];
  confusion: ConfusionPair[];
  /** file order, includes skipped cases */
  cases: CaseReport[];
  baseline: BaselineSummary | null;
}

export interface CaseReport {
  index: number;
  id: string | null;
  query: string;
  note: string | null;
  expect: string[];
  expect_any: string[];
  forbid: string[];
  first: string | null;
  none: boolean;
  status: "passed" | "failed" | "skipped";
  passed: number;
  threshold: number;
  /** [] for skipped cases */
  runs: RunVerdict[];
  change: Change | null;
  cached?: boolean;
}

/** A planned case with its result; result === null means the budget skipped it. */
export interface ReportCase {
  c: Case;
  threshold: number;
  result: CaseResult | null;
}

export interface ReportInput {
  file: string;
  agent: string;
  model: string | null;
  /** batch mode: the model stated its choices instead of making them */
  batch?: boolean;
  /** epoch ms */
  startedAtMs: number;
  durationMs: number;
  /** every selected case in file order, skipped ones included */
  cases: ReportCase[];
  unavailable: string[];
  confusion: ConfusionPair[];
  /** known costs plus runs priced from their tokens */
  estimatedCostUsd: number;
  /** costs of runs made for cases the budget then skipped; counted in runs and costUsd */
  skippedRunCosts?: (number | null)[];
  budgetUsd: number | null;
  budgetReached: boolean;
  baseline?: SuiteReport | null;
  baselineFile?: string;
  /** every case of the cases file, filtered out ones included */
  suiteCases?: { id: string | null; query: string }[];
  cached?: boolean[];
}

/** The single source of truth for --json and --junit; computed once per run. */
export function buildReport(input: ReportInput): SuiteReport {
  const verdicts = input.cases.flatMap((e, i) => input.cached?.[i] ? [] : (e.result?.runs ?? []));
  const costs = [...verdicts.map((v) => v.costUsd), ...(input.skippedRunCosts ?? [])];
  const known = costs.filter((c): c is number => c !== null);
  const cachedCount = input.cached?.filter(Boolean).length ?? 0;
  const savedUsd = input.cases.reduce((sum, e, i) => input.cached?.[i] ? sum + (e.result?.runs ?? []).reduce((n, r) => n + (r.costUsd ?? 0), 0) : sum, 0);
  const cases = input.cases.map((e, i) => toCaseReport(e, input.cached?.[i] ?? false));
  const comparison = input.baseline ? compare(cases, input.baseline, input.baselineFile ?? input.baseline.file, input.suiteCases ?? cases) : null;
  return {
    tool: "skillcheck",
    version: readVersion(),
    file: input.file,
    agent: input.agent,
    model: input.model,
    batch: input.batch ?? false,
    startedAt: new Date(input.startedAtMs).toISOString(),
    durationMs: input.durationMs,
    summary: {
      cases: input.cases.length,
      failed: input.cases.filter((e) => e.result && !e.result.ok).length,
      skipped: input.cases.filter((e) => !e.result).length,
      runs: costs.length,
      costUsd: known.reduce((a, b) => a + b, 0),
      unknownCostRuns: costs.length - known.length,
      estimatedCostUsd: input.estimatedCostUsd,
      diagnoses: verdicts.filter((v) => v.diagnosis).length,
      budgetUsd: input.budgetUsd,
      budgetReached: input.budgetReached,
      cached: cachedCount,
      ...(cachedCount > 0 ? { savedUsd } : {}),
    },
    unavailable: input.unavailable,
    confusion: input.confusion,
    cases: comparison ? cases.map((c, i) => ({ ...c, change: comparison.changes[i] ?? null })) : cases,
    baseline: comparison?.summary ?? null,
  };
}

function toCaseReport(e: ReportCase, cached: boolean): CaseReport {
  const c = e.c;
  return {
    index: c.index,
    id: c.id ?? null,
    query: c.query,
    note: c.note ?? null,
    expect: c.expect,
    expect_any: c.expect_any,
    forbid: c.forbid,
    first: c.first ?? null,
    none: c.none,
    status: e.result ? (e.result.ok ? "passed" : "failed") : "skipped",
    passed: e.result?.passed ?? 0,
    threshold: e.result?.threshold ?? e.threshold,
    runs: e.result?.runs ?? [],
    change: null,
    cached,
  };
}
