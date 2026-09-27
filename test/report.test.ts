import { describe, expect, it } from "vitest";
import type { Case } from "../src/cases.js";
import type { RunVerdict, CaseResult } from "../src/judge.js";
import { Reporter, type ReportStream } from "../src/report.js";

function makeSink(isTTY = false): { text: () => string; stream: ReportStream } {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
  } as unknown as ReportStream;
  return { text: () => chunks.join(""), stream };
}

function kase(over: Partial<Case> = {}): Case {
  return {
    index: 1, query: "why does TestOrderCreate fail?", expect: ["find-bug"],
    expect_any: [], forbid: [], none: false, ...over,
  };
}

function verdict(over: Partial<RunVerdict> = {}): RunVerdict {
  return {
    ok: true, reasons: [], reason: "", loaded: ["find-bug"], diagnosis: null,
    costUsd: 0.1, error: null, stoppedEarly: false, durationMs: 0, ...over,
  };
}

function result(over: Partial<CaseResult> & { c?: Case; runs?: RunVerdict[] } = {}): CaseResult {
  const c = over.c ?? kase();
  const runs = over.runs ?? [verdict()];
  const passed = runs.filter((r) => r.ok).length;
  return { case: c, runs, passed, ok: over.ok ?? (passed === runs.length), threshold: over.threshold ?? 1 };
}

describe("Reporter", () => {
  it("prints the header with the planned run count", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).header(25, 1, 1, 25);
    expect(text()).toBe("25 cases × 1 repeat × 1 agent = 25 runs\n");
  });

  it("prints the batch header with the call count", () => {
    const { text, stream } = makeSink();
    const reporter = new Reporter(stream);
    reporter.batchHeader(23, 1, 1);
    reporter.batchHeader(5, 2, 6);
    expect(text()).toBe(
      "23 cases × 1 repeat, batch mode = 1 call\n5 cases × 2 repeat, batch mode = 6 calls\n",
    );
  });

  it("dims a note on a TTY and leaves it plain otherwise", () => {
    const plain = makeSink(false);
    new Reporter(plain.stream).note("advice");
    expect(plain.text()).toBe("advice\n");
    const tty = makeSink(true);
    new Reporter(tty.stream).note("advice");
    expect(tty.text()).toBe("\u001b[2madvice\u001b[0m\n");
  });

  it("prints an ok line with the loaded skills", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).caseDone(result());
    expect(text()).toBe("ok    #1  why does TestOrderCreate fail?  → find-bug\n");
  });

  it("prints a FAIL line with label, loaded list and the first failed reason", () => {
    const { text, stream } = makeSink();
    const res = result({
      c: kase({ index: 2, id: "cart", expect: [], expect_any: ["stability", "test-guard"], forbid: ["find-bug"] }),
      ok: false,
      runs: [verdict({ ok: false, loaded: ["find-bug"], reason: "not loaded any of [stability, test-guard]; forbidden find-bug" })],
    });
    new Reporter(stream).caseDone(res);
    expect(text()).toBe(
      "FAIL  #cart  why does TestOrderCreate fail?  → find-bug · not loaded any of [stability, test-guard]; forbidden find-bug\n",
    );
  });

  it("shows — when nothing loaded and truncates long queries", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).caseDone(result({ c: kase({ query: "x".repeat(60) }), runs: [verdict({ loaded: [] })] }));
    expect(text()).toBe(`ok    #1  ${"x".repeat(48)}…  → —\n`);
  });

  it("collapses multi-line queries to one line", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).caseDone(result({ c: kase({ query: "line one\nline   two" }) }));
    expect(text()).toContain("line one line two");
  });

  it("shows passed/total and the union of loaded for repeated runs", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).caseDone(result({
      c: kase(),
      runs: [verdict({ loaded: ["find-bug"] }), verdict({ loaded: ["find-bug", "test-guard"] }), verdict({ ok: false, loaded: ["other"], reason: "forbidden other" })],
      threshold: 1, ok: false,
    }));
    expect(text()).toBe("FAIL  #1  why does TestOrderCreate fail? 2/3  → find-bug, test-guard, other · forbidden other\n");
  });

  it("prints the diagnosis line under the case", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).caseDone(result({
      c: kase({ index: 2 }), ok: false,
      runs: [verdict({ ok: false, loaded: [], reason: "not loaded find-bug", diagnosis: "skill named in text but not invoked — a model or directive limit, not routing" })],
    }));
    expect(text()).toContain("      diagnosis #2: skill named in text but not invoked");
  });

  it("summarises failures, runs and costs", () => {
    const { text, stream } = makeSink();
    const reporter = new Reporter(stream);
    reporter.summary([
      result({ runs: [verdict({ costUsd: 0.1 })] }),
      result({ c: kase({ index: 2 }), ok: false, runs: [verdict({ ok: false, costUsd: 0.044, loaded: [] })] }),
    ]);
    expect(text()).toBe("\n1 failed of 2 · runs 2 · cost $0.14\n");
  });

  it("marks unknown costs", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).summary([
      result({ runs: [verdict({ costUsd: 0.05 }), verdict({ costUsd: null })] }),
    ]);
    expect(text()).toBe("\n0 failed of 1 · runs 2 · cost $0.05 (+? for 1 runs)\n");
  });

  it("shows the token estimate when it prices the unknown costs", () => {
    const runs = [verdict({ costUsd: 0.05 }), verdict({ costUsd: null })];
    const priced = makeSink();
    new Reporter(priced.stream).summary([result({ runs })], { estimatedUsd: 0.12 });
    expect(priced.text()).toBe("\n0 failed of 1 · runs 2 · cost ~$0.12 (1 runs estimated from tokens)\n");
    const unpriced = makeSink(); // nothing to estimate from: keep the known sum
    new Reporter(unpriced.stream).summary([result({ runs })], { estimatedUsd: 0.05 });
    expect(unpriced.text()).toBe("\n0 failed of 1 · runs 2 · cost $0.05 (+? for 1 runs)\n");
  });

  it("prints cost ? when no cost is known and warns about diagnoses and missing skills", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).summary(
      [result({ runs: [verdict({ costUsd: null, diagnosis: "d" }), verdict({ costUsd: null, diagnosis: "d" })] })],
      { unavailable: ["find-bug", "test-guard"] },
    );
    expect(text()).toBe(
      "\nwarning: 2 diagnoses. reproduce on a stronger model before editing descriptions\n" +
        "warning: expected skills not available to the agent: find-bug, test-guard\n" +
        "0 failed of 1 · runs 2 · cost ?\n",
    );
  });

  it("prints the confusion block after warnings and before the totals", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).summary(
      [result({ ok: false, runs: [verdict({ ok: false, loaded: ["find-bug"] })] })],
      {
        unavailable: ["gone"],
        confusion: [
          { expected: "test-guard", got: "find-bug", count: 2 },
          { expected: "find-bug", got: "(nothing)", count: 1 },
        ],
      },
    );
    expect(text()).toBe(
      "\nwarning: expected skills not available to the agent: gone\n" +
        "confusion:\n" +
        "  expected test-guard → got find-bug (2)\n" +
        "  expected find-bug → got (nothing) (1)\n" +
        "1 failed of 1 · runs 1 · cost $0.10\n",
    );
  });

  it("omits the confusion block when there are no pairs", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).summary([result()], { confusion: [] });
    expect(text()).not.toContain("confusion");
  });

  it("prints a skip line for a budget-skipped case", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).caseSkipped(kase({ index: 5, query: "slow one" }));
    expect(text()).toBe("skip  #5  slow one  → budget reached\n");
    const tty = makeSink(true);
    new Reporter(tty.stream).caseSkipped(kase({ index: 5, query: "slow one" }));
    expect(tty.text()).toContain("\u001b[33mskip");
  });

  it("counts skipped cases in the totals and prints the budget line", () => {
    const { text, stream } = makeSink();
    new Reporter(stream).summary([result({ runs: [verdict({ costUsd: 0.05 })] })], {
      skipped: 2,
      budget: { limitUsd: 1, spent: 1.2, notStartedRuns: 3 },
    });
    expect(text()).toBe(
      "\nbudget $1.00 reached (spent ~$1.20), 3 runs not started\n" +
        "0 failed, 2 skipped of 3 · runs 1 · cost $0.05\n",
    );
  });

  it("emits no ANSI codes on a non-TTY stream", () => {
    const { text, stream } = makeSink(false);
    const reporter = new Reporter(stream);
    reporter.caseDone(result({ ok: false, runs: [verdict({ ok: false, reason: "nope" })] }));
    reporter.summary([result({ ok: false, runs: [verdict({ ok: false })] })]);
    expect(text()).not.toContain("\u001b[");
  });

  it("colors the verdict marks on a TTY", () => {
    const { text, stream } = makeSink(true);
    new Reporter(stream).caseDone(result());
    expect(text()).toContain("\u001b[32mok");
  });
});
