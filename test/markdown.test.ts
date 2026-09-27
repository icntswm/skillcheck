import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/agents/types.js";
import type { Case } from "../src/cases.js";
import type { ConfusionPair } from "../src/confusion.js";
import { aggregate, judge, type RunVerdict } from "../src/judge.js";
import { MARKDOWN_MARKER, toMarkdown } from "../src/markdown.js";
import { buildReport, type ReportCase, type SuiteReport } from "../src/results.js";

function kase(over: Partial<Case> = {}): Case {
  return { index: 1, query: "why does it fail", expect: ["find-bug"], expect_any: [], forbid: [], none: false, ...over };
}

function verdict(c: Case, over: Partial<RunResult> = {}): RunVerdict {
  const r: RunResult = {
    loaded: [], text: "", costUsd: 0.01, availableSkills: null,
    error: null, stoppedEarly: false, durationMs: 1000, ...over,
  };
  return judge(c, r);
}

function done(c: Case, runs: RunVerdict[]): ReportCase {
  return { c, threshold: 1, result: aggregate(c, runs, 1) };
}

interface Over {
  model?: string | null;
  batch?: boolean;
  estimatedCostUsd?: number;
  budgetUsd?: number | null;
  budgetReached?: boolean;
  cached?: boolean[];
  unavailable?: string[];
  confusion?: ConfusionPair[];
  durationMs?: number;
  baseline?: SuiteReport | null;
}

function makeReport(cases: ReportCase[], over: Over = {}): string {
  const {
    model = "sonnet", batch = false, estimatedCostUsd = 0, baseline = null,
    budgetUsd = null, budgetReached = false, unavailable = [], confusion = [], durationMs = 12_345,
    cached = undefined,
  } = over;
  return toMarkdown(buildReport({
    file: "skillcheck.yaml", agent: "claude", model, batch,
    startedAtMs: Date.parse("2026-09-27T10:00:00Z"), durationMs,
    cases, unavailable, confusion, estimatedCostUsd, budgetUsd, budgetReached, baseline, cached,
  }));
}

describe("toMarkdown", () => {
  const c1 = kase();
  const c2 = kase({ index: 2, id: "stability", query: "multi\nline   query" });
  const c3 = kase({ index: 3, query: "timeout case" });
  const c4 = kase({ index: 4, query: "never started" });

  function sample(): string {
    return makeReport([
      done(c1, [verdict(c1, { loaded: ["find-bug"], durationMs: 2000 })]),
      done(c2, [
        verdict(c2, { loaded: ["find-bug"] }),
        verdict(c2, { loaded: [], text: "try the find-bug skill" }), // names find-bug in text → diagnosis
      ]),
      done(c3, [verdict(c3, { error: "timeout after 180s" })]),
      { c: c4, threshold: 1, result: null },
    ]);
  }

  it("all passed: green header, passing rows inside details, no failure table", () => {
    const md = makeReport([
      done(c1, [verdict(c1, { loaded: ["find-bug"] })]),
      done(c2, [verdict(c2, { loaded: ["find-bug"] })]),
    ]);
    const lines = md.split("\n");
    expect(lines[0]).toBe(MARKDOWN_MARKER);
    expect(lines[1]).toBe("### ✅ skillcheck: 2 passed");
    expect(lines[3]).toBe("sonnet · 2 runs · cost $0.02 · 12s");
    expect(md).toContain("<details><summary>Passed (2)</summary>");
    expect(md).toContain("| #1 | why does it fail | find-bug |");
    expect(md).toContain("| #stability | multi line query | find-bug |");
    expect(md).not.toContain("Reason |");
    expect(md).not.toContain("❌");
    expect(md.endsWith("</details>\n")).toBe(true);
  });

  it("shows cached cases in the header", () => {
    const md = makeReport([done(c1, [verdict(c1, { loaded: ["find-bug"] })])], { cached: [true] });
    expect(md).toContain("### ✅ skillcheck: 1 passed, 1 cached");
  });

  it("renders baseline counts and change labels", () => {
    const c2 = kase({ index: 2, query: "fixed case" });
    const c3 = kase({ index: 3, query: "new case" });
    const c4 = kase({ index: 4, query: "removed case" });
    const old = buildReport({
      file: "old.json", agent: "claude", model: "sonnet", startedAtMs: 0, durationMs: 0,
      cases: [
        done(c1, [verdict(c1, { loaded: ["find-bug"] })]),
        done(c2, [verdict(c2, { loaded: [] })]),
        done(c4, [verdict(c4, { loaded: ["find-bug"] })]),
      ], unavailable: [], confusion: [], estimatedCostUsd: 0, budgetUsd: null, budgetReached: false,
    });
    const fixed = buildReport({
      file: "skillcheck.yaml", agent: "claude", model: "sonnet", startedAtMs: 0, durationMs: 0,
      cases: [
        done(c1, [verdict(c1, { loaded: [] })]),
        done(c2, [verdict(c2, { loaded: ["find-bug"] })]),
        done(c3, [verdict(c3, { loaded: ["find-bug"] })]),
      ], unavailable: [], confusion: [], estimatedCostUsd: 0, budgetUsd: null, budgetReached: false,
      baseline: old, baselineFile: "old.json",
    });
    expect(toMarkdown(fixed)).toContain("> Since baseline: **1 regressed**, 1 fixed, 1 new, 1 removed.");
    expect(toMarkdown(fixed)).toContain("**regressed** · not loaded find-bug");
    const passedOld = buildReport({
      file: "old.json", agent: "claude", model: "sonnet", startedAtMs: 0, durationMs: 0,
      cases: [done(c1, [verdict(c1, { loaded: [] })])], unavailable: [], confusion: [], estimatedCostUsd: 0, budgetUsd: null, budgetReached: false,
    });
    const passed = buildReport({
      file: "skillcheck.yaml", agent: "claude", model: "sonnet", startedAtMs: 0, durationMs: 0,
      cases: [done(c1, [verdict(c1, { loaded: ["find-bug"] })])], unavailable: [], confusion: [], estimatedCostUsd: 0, budgetUsd: null, budgetReached: false,
      baseline: passedOld,
    });
    expect(toMarkdown(passed)).toContain("find-bug · fixed");
  });

  it("does not add baseline text without a baseline", () => {
    expect(makeReport([done(c1, [verdict(c1, { loaded: ["find-bug"] })])])).not.toContain("baseline");
  });

  it("failed, errored and skipped rows get their marks and reasons", () => {
    const md = sample();
    expect(md.split("\n")[1]).toBe("### ❌ skillcheck: 2 failed, 1 skipped of 4");
    // failed with a diagnosis, two runs → score prefix and italic diagnosis
    expect(md).toContain("| ❌ | #stability | multi line query | find-bug | 1/2 · not loaded find-bug — _skill named in text but not invoked — a model or directive limit, not routing_ |");
    // every failed run errored → ⚠️ with the error as the reason
    expect(md).toContain("| ⚠️ | #3 | timeout case | — | timeout after 180s |");
    // never started → ⏭️, no loaded skills, the budget reason
    expect(md).toContain("| ⏭️ | #4 | never started | — | budget reached |");
  });

  it("skipped alone still fails the header without a failed count", () => {
    const md = makeReport([{ c: c4, threshold: 1, result: null }]);
    expect(md.split("\n")[1]).toBe("### ❌ skillcheck: 1 skipped of 1");
    expect(md).toContain("| ⏭️ | #4 | never started | — | budget reached |");
  });

  it("a repeat run prefixes the pass share in the reason cell", () => {
    const c = kase({ index: 7 });
    const md = makeReport([
      done(c, [
        verdict(c, { loaded: ["find-bug"] }),
        verdict(c, { loaded: [] }),
        verdict(c, { loaded: [] }),
      ]),
    ]);
    expect(md.split("\n")[1]).toBe("### ❌ skillcheck: 1 failed of 1");
    expect(md).toContain("| ❌ | #7 | why does it fail | find-bug | 1/3 · not loaded find-bug |");
  });

  it("a passed case over several runs appends its score in the details table", () => {
    const c = kase();
    const runs = [verdict(c, { loaded: ["find-bug"] }), verdict(c, { loaded: [] })];
    const md = makeReport([{ c, threshold: 0.5, result: aggregate(c, runs, 0.5) }]);
    expect(md).toContain("| #1 (1/2) | why does it fail | find-bug |");
  });

  it("escapes pipes, newlines and HTML in cells", () => {
    const nasty = kase({ index: 9, query: "a | b\n<script> | d" });
    const md = makeReport([done(nasty, [verdict(nasty, { loaded: ["find-bug"] }), verdict(nasty, { loaded: [] })])]);
    const entity = `${"&"}lt;`; // avoid the literal entity in source
    expect(md).toContain(`| ❌ | #9 | a \\| b ${entity}script> \\| d | find-bug | 1/2 · not loaded find-bug |`);
  });

  it("truncates a long query to 80 chars with an ellipsis", () => {
    const long = kase({ query: "x".repeat(90) });
    const md = makeReport([done(long, [verdict(long, { error: "timeout after 180s" })])]);
    expect(md).toContain(`| ⚠️ | #1 | ${"x".repeat(80)}… | — | timeout after 180s |`);
  });

  it("uses the estimated cost with a tilde when runs without a cost raise the spend", () => {
    const md = makeReport([
      done(c1, [verdict(c1, { loaded: ["find-bug"], costUsd: null })]),
      done(c2, [verdict(c2, { loaded: ["find-bug"] })]),
    ], { estimatedCostUsd: 0.03 });
    // costUsd is 0.01, the estimate covers the unknown run
    expect(md).toContain("cost ~$0.03 · ");
    const plain = makeReport([done(c1, [verdict(c1, { loaded: ["find-bug"] })])], { estimatedCostUsd: 0.03 });
    expect(plain).toContain("cost $0.01 · ");
  });

  it("batch mode adds the meta tag and the confirmation note", () => {
    const md = makeReport([
      done(c1, [verdict(c1, { loaded: ["find-bug"] })]),
      done(c2, [verdict(c2, { loaded: [] })]),
    ], { batch: true });
    expect(md.split("\n")[3]).toBe("sonnet · batch mode · 2 runs · cost $0.02 · 12s");
    expect(md).toContain("> Batch mode: answers are the model's stated choice, not an actual Skill call. Confirm failures with a normal run.");
  });

  it("omits the model part when there is no model", () => {
    const md = makeReport([done(c1, [verdict(c1, { loaded: ["find-bug"] })])], { model: null });
    expect(md.split("\n")[3]).toBe("1 run · cost $0.01 · 12s");
  });

  it("formats durations below and above a minute", () => {
    const under = makeReport([done(c1, [verdict(c1, { loaded: ["find-bug"] })])], { durationMs: 42_123 });
    expect(under.split("\n")[3]).toBe("sonnet · 1 run · cost $0.01 · 42s");
    const over = makeReport([done(c1, [verdict(c1, { loaded: ["find-bug"] })])], { durationMs: 72_000 });
    expect(over.split("\n")[3]).toBe("sonnet · 1 run · cost $0.01 · 1m 12s");
    expect(makeReport([], { durationMs: 120_999 })).toContain("2m 0s");
  });

  it("a reached budget prints its warning line with the limit", () => {
    const md = makeReport(
      [done(c1, [verdict(c1, { loaded: ["find-bug"] })]), { c: c4, threshold: 1, result: null }],
      { budgetUsd: 0.5, budgetReached: true },
    );
    expect(md).toContain("> ⚠️ Budget $0.50 reached, remaining cases were skipped.");
  });

  it("unavailable skills get a warning line", () => {
    const md = makeReport([done(c1, [verdict(c1, { loaded: [] })])], { unavailable: ["find-bug", "test-guard"] });
    expect(md).toContain("> ⚠️ Expected skills not available to the agent: find-bug, test-guard");
  });

  it("confusion pairs become bullets with counts", () => {
    const confusion: ConfusionPair[] = [{ expected: "find-bug", got: "test-guard", count: 2 }];
    const md = makeReport([done(c1, [verdict(c1, { loaded: ["test-guard"] })])], { confusion });
    expect(md).toContain("**Confusion** — descriptions to rewrite:");
    expect(md).toContain("- expected `find-bug` → got `test-guard` (2)");
  });
});
