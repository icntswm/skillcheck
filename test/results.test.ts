import { describe, expect, it } from "vitest";
import { aggregate, judge } from "../src/judge.js";
import { buildReport, type ReportCase } from "../src/results.js";
import type { Case } from "../src/cases.js";
import type { RunResult } from "../src/agents/types.js";

const c: Case = { index: 1, query: "q", expect: ["skill"], expect_any: [], forbid: [], none: false };

function reportCase(costUsd: number | null): ReportCase {
  const run: RunResult = { loaded: ["skill"], text: "", costUsd, availableSkills: null, error: null, stoppedEarly: false, durationMs: 1 };
  return { c, threshold: 1, result: aggregate(c, [judge(c, run)], 1) };
}

function input(cases: ReportCase[], cached?: boolean[]) {
  return { file: "x", agent: "claude", model: null, startedAtMs: 0, durationMs: 0, cases, unavailable: [], confusion: [], estimatedCostUsd: 0, budgetUsd: null, budgetReached: false, cached };
}

describe("buildReport cache savings", () => {
  it("sums only non-null costs from cached cases and omits savings when none are cached", () => {
    const report = buildReport(input([reportCase(1.2), reportCase(null)], [true, true]));
    expect(report.summary.savedUsd).toBe(1.2);
    const fresh = buildReport(input([reportCase(1.2)]));
    expect(fresh.summary).not.toHaveProperty("savedUsd");
  });
});
