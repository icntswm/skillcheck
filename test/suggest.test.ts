import { describe, expect, it } from "vitest";
import { buildSuggestPrompt, parseSuggestAnswer, suggestEvidence } from "../src/suggest.js";
import type { SkillDoc } from "../src/describe.js";
import type { SuiteReport } from "../src/results.js";

const doc = (name: string, description: string): SkillDoc => ({ name, kind: "skill", file: `/tmp/${name}/SKILL.md`, description, plugin: null });
const run = (loaded: string[], ok = false) => ({ ok, reasons: [], reason: "", loaded, diagnosis: null, costUsd: 0, error: null, stoppedEarly: false, durationMs: 1 });

function report(over: Partial<SuiteReport> = {}): SuiteReport {
  return { tool: "skillcheck", version: "1", file: "r.json", agent: "claude", model: null, batch: false, startedAt: "", durationMs: 0,
    summary: { cases: 0, failed: 0, skipped: 0, runs: 0, costUsd: 0, unknownCostRuns: 0, estimatedCostUsd: 0, diagnoses: 0, budgetUsd: null, budgetReached: false },
    unavailable: [], confusion: [], cases: [], baseline: null, ...over };
}

describe("suggest helpers", () => {
  it("gets targets from split confusion labels and skips nothing", () => {
    const evidence = suggestEvidence(report({ confusion: [
      { expected: "a|b", got: "c", count: 2 }, { expected: "a", got: "(nothing)", count: 1 },
    ] }), ["a", "b", "c"]);
    expect([...evidence.keys()]).toEqual(["a", "b", "c"]);
    expect(evidence.get("a")?.confusion).toHaveLength(2);
    expect(evidence.get("c")?.confusion).toHaveLength(1);
  });

  it("limits evidence, truncates queries, and records distinct failed loaded lists", () => {
    const long = "x".repeat(350);
    const cases: SuiteReport["cases"] = Array.from({ length: 10 }, (_, i) => ({ index: i, id: null, query: `${long}${i}`, note: null, expect: ["a"], expect_any: [], forbid: [], first: null, none: false, status: "failed" as const, passed: 0, threshold: 1, runs: i === 0 ? [run(["c"]), run(["b"])] : [run(["c"]), run(["c"])], change: null })) as SuiteReport["cases"];
    cases.push(...Array.from({ length: 7 }, (_, i) => ({ index: 20 + i, id: null, query: `keep ${i}`, note: null, expect: ["a"], expect_any: [], forbid: [], first: null, none: false, status: "passed" as const, passed: 1, threshold: 1, runs: [run(["a"], true)], change: null })) as SuiteReport["cases"]);
    const evidence = suggestEvidence(report({ cases }), ["a"]);
    const item = evidence.get("a")!;
    expect(item.failing).toHaveLength(8);
    expect(item.failing[0]!.query).toHaveLength(300);
    expect(item.failing[0]!.loaded).toEqual([["c"], ["b"]]);
    expect(item.keepWorking).toEqual(["keep 0", "keep 1", "keep 2", "keep 3", "keep 4"]);
  });

  it("gives a skill loaded in a neighbour's place the failing query too", () => {
    const cases = [{ index: 1, id: null, query: "migrate schema", note: null, expect: ["a"], expect_any: [], forbid: [], first: null, none: false, status: "failed" as const, passed: 0, threshold: 1, runs: [run(["b"])], change: null }] as SuiteReport["cases"];
    const evidence = suggestEvidence(report({ cases, confusion: [{ expected: "a", got: "b", count: 1 }] }), ["a", "b"]);
    expect(evidence.get("b")?.failing).toEqual([{ query: "migrate schema", loaded: [["b"]] }]);
  });

  it("builds a prompt with descriptions, neighbours, and editing rules", () => {
    const targets = [doc("a", "Use A for database migrations")];
    const evidence = new Map([["a", { confusion: [{ expected: "a", got: "b", count: 3 }], failing: [{ query: "migrate schema", loaded: [["b"]] }], keepWorking: ["run the migration"] }]]);
    const prompt = buildSuggestPrompt(targets, [...targets, doc("b", "Use B for API docs")], evidence);
    expect(prompt).toContain("Use A for database migrations");
    expect(prompt).toContain("b");
    expect(prompt).toContain("migrate schema");
    expect(prompt).toContain("at most 1024 characters");
    expect(prompt).toContain("Do not mention test cases or skillcheck");
  });

  it("drops invalid, unchanged, and duplicate suggestions", () => {
    const answer = { suggestions: [
      { skill: "a", description: "new A", reason: "r" }, { skill: "a", description: "second", reason: "r" },
      { skill: "ghost", description: "x", reason: "r" }, { skill: "a", description: " ", reason: "r" },
      { skill: "b", description: "old B", reason: "r" }, { skill: "b", description: "x".repeat(1025), reason: "r" },
    ] };
    expect(parseSuggestAnswer(answer, [doc("a", "old A"), doc("b", "old B")])).toEqual({ suggestions: [{ skill: "a", description: "new A", reason: "r" }], dropped: 5 });
  });
});
