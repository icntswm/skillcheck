import { describe, expect, it } from "vitest";
import type { Case } from "../src/cases.js";
import { aggregate, type CaseResult, type RunVerdict } from "../src/judge.js";
import { confusion } from "../src/confusion.js";

function kase(over: Partial<Case> = {}): Case {
  return { index: 1, query: "q", expect: [], expect_any: [], forbid: [], none: false, ...over };
}

function run(over: Partial<RunVerdict> = {}): RunVerdict {
  return {
    ok: false, reasons: ["x"], reason: "x", loaded: [], diagnosis: null,
    costUsd: null, error: null, stoppedEarly: false, durationMs: 0, ...over,
  };
}

function result(c: Case, runs: RunVerdict[]): CaseResult {
  return aggregate(c, runs, 1);
}

describe("confusion", () => {
  it("a missing expected skill and an unexpected loaded one form a pair", () => {
    const pairs = confusion([result(kase({ expect: ["find-bug"] }), [run({ loaded: ["test-guard"] })])]);
    expect(pairs).toEqual([{ expected: "find-bug", got: "test-guard", count: 1 }]);
  });

  it("nothing loaded becomes the (nothing) got label", () => {
    const pairs = confusion([result(kase({ expect: ["find-bug"] }), [run({ loaded: [] })])]);
    expect(pairs).toEqual([{ expected: "find-bug", got: "(nothing)", count: 1 }]);
  });

  it("every missing expect pairs with every unexpected loaded skill", () => {
    const c = kase({ expect: ["a", "b"], forbid: ["x"] });
    const pairs = confusion([result(c, [run({ loaded: ["x", "y"] })])]);
    expect(pairs).toHaveLength(4);
    expect(pairs.map((p) => `${p.expected}→${p.got}`).sort()).toEqual(
      ["a→x", "a→y", "b→x", "b→y"].sort(),
    );
  });

  it("an unsatisfied expect_any collapses to one a|b label", () => {
    const c = kase({ expect_any: ["stability", "test-guard"] });
    const pairs = confusion([result(c, [run({ loaded: ["find-bug"] })])]);
    expect(pairs).toEqual([{ expected: "stability|test-guard", got: "find-bug", count: 1 }]);
  });

  it("a satisfied expect_any adds no label", () => {
    const c = kase({ expect_any: ["stability", "test-guard"], forbid: ["find-bug"] });
    const pairs = confusion([result(c, [run({ loaded: ["stability", "find-bug"] })])]);
    expect(pairs).toEqual([]); // only the forbid failed
  });

  it("a wrong first skill becomes the expected label", () => {
    const c = kase({ expect: ["find-bug"], first: "find-bug" });
    const pairs = confusion([result(c, [run({ loaded: ["other", "find-bug"] })])]);
    // find-bug was loaded (no expect label); first mismatch adds "find-bug" once;
    // "other" is unexpected, "find-bug" was asked for
    expect(pairs).toEqual([{ expected: "find-bug", got: "other", count: 1 }]);
  });

  it("a first label already added from expect is not duplicated", () => {
    const c = kase({ expect: ["find-bug"], first: "find-bug" });
    const pairs = confusion([result(c, [run({ loaded: ["other"] })])]);
    expect(pairs).toEqual([{ expected: "find-bug", got: "other", count: 1 }]);
  });

  it("runs that failed only on forbid or none produce no pairs", () => {
    const forbidOnly = result(kase({ forbid: ["find-bug"] }), [run({ loaded: ["find-bug"] })]);
    const noneOnly = result(kase({ none: true }), [run({ loaded: ["find-bug"] })]);
    expect(confusion([forbidOnly, noneOnly])).toEqual([]);
  });

  it("ok and error runs are ignored", () => {
    const ok = result(kase({ expect: ["find-bug"] }), [run({ ok: true, loaded: ["other"] })]);
    const err = result(kase({ expect: ["find-bug"] }), [run({ loaded: ["other"], error: "timeout" })]);
    expect(confusion([ok, err])).toEqual([]);
  });

  it("counts repeat across runs of a case", () => {
    const c = kase({ expect: ["find-bug"] });
    const runs = [run({ loaded: [] }), run({ loaded: [] }), run({ ok: true, loaded: ["find-bug"] })];
    expect(confusion([result(c, runs)])).toEqual([{ expected: "find-bug", got: "(nothing)", count: 2 }]);
  });

  it("sorts by count desc, then expected, then got", () => {
    const results = [
      result(kase({ index: 1, expect: ["a"] }), [run({ loaded: ["z"] })]),
      result(kase({ index: 2, expect: ["b"] }), [run({ loaded: ["z"] }), run({ loaded: ["z"] })]),
      result(kase({ index: 3, expect: ["b"] }), [run({ loaded: ["a"] })]),
      result(kase({ index: 4, expect: ["b"] }), [run({ loaded: [] })]),
    ];
    const pairs = confusion(results);
    expect(pairs.map((p) => `${p.expected}→${p.got}:${p.count}`)).toEqual([
      "b→z:2",
      "a→z:1",
      "b→(nothing):1",
      "b→a:1",
    ]);
  });
});
