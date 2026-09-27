import { describe, expect, it } from "vitest";
import { compare, parseBaseline, type BaselineSummary } from "../src/baseline.js";
import type { CaseReport, SuiteReport } from "../src/results.js";

function kase(over: Partial<CaseReport> = {}): CaseReport {
  return {
    index: 1, id: null, query: "q", note: null, expect: [], expect_any: [], forbid: [], first: null,
    none: false, status: "passed", passed: 1, threshold: 1, runs: [], change: null, ...over,
  };
}

function baseline(cases: CaseReport[]): SuiteReport {
  return { tool: "skillcheck", version: "1.0.0", file: "old.json", agent: "claude", model: "sonnet", batch: false,
    startedAt: "2026-01-01T00:00:00.000Z", durationMs: 0,
    summary: { cases: cases.length, failed: 0, skipped: 0, runs: 0, costUsd: 0, unknownCostRuns: 0, estimatedCostUsd: 0, diagnoses: 0, budgetUsd: null, budgetReached: false },
    unavailable: [], confusion: [], cases, baseline: null };
}

describe("parseBaseline", () => {
  it("accepts a skillcheck report", () => {
    expect(parseBaseline(JSON.stringify(baseline([]))).tool).toBe("skillcheck");
  });

  it.each([null, [], { tool: "other", cases: [] }, { tool: "skillcheck" }])("rejects %j", (value) => {
    expect(() => parseBaseline(JSON.stringify(value))).toThrow("not a skillcheck --json report");
  });

  it("lets invalid JSON errors through", () => {
    expect(() => parseBaseline("{bad")).toThrow(SyntaxError);
  });
});

describe("compare", () => {
  it("marks regressions, fixes, new and removed cases", () => {
    const old = baseline([
      kase({ index: 1, id: "old-fail", status: "failed" }),
      kase({ index: 2, id: "fixed", status: "failed" }),
      kase({ index: 3, id: "regressed", status: "passed" }),
      kase({ index: 4, id: "removed" }),
    ]);
    const current = [
      kase({ index: 1, id: "old-fail", status: "failed" }),
      kase({ index: 2, id: "fixed", status: "passed" }),
      kase({ index: 3, id: "regressed", status: "failed" }),
      kase({ index: 5, id: "new", status: "passed" }),
    ];
    expect(compare(current, old, "previous.json")).toEqual({
      changes: [null, "fixed", "regressed", "new"],
      summary: { file: "previous.json", regressed: 1, fixed: 1, new: 1, removed: 1 } satisfies BaselineSummary,
    });
  });

  it("does not compare skipped cases", () => {
    const old = baseline([kase({ id: "old", status: "skipped" }), kase({ id: "current", status: "passed" })]);
    const current = [kase({ id: "old", status: "failed" }), kase({ id: "current", status: "skipped" })];
    expect(compare(current, old, "x").changes).toEqual([null, null]);
  });

  it("matches by id or exact query, keeps ids separate from queries, and uses the first duplicate", () => {
    const old = baseline([
      kase({ id: "same", query: "one", status: "passed" }),
      kase({ id: null, query: "same", status: "failed" }),
      kase({ id: "dup", status: "passed" }),
      kase({ id: "dup", status: "failed" }),
    ]);
    const current = [
      kase({ id: "same", query: "changed", status: "failed" }),
      kase({ id: null, query: "same", status: "passed" }),
      kase({ id: "dup", status: "failed" }),
      kase({ id: "other", query: "one", status: "failed" }),
    ];
    expect(compare(current, old, "x").changes).toEqual(["regressed", "fixed", "regressed", "new"]);
  });
});
