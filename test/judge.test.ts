import { describe, expect, it } from "vitest";
import type { Case } from "../src/cases.js";
import type { RunResult } from "../src/agents/types.js";
import { aggregate, DIAGNOSIS, judge } from "../src/judge.js";

function makeCase(part: Partial<Case>): Case {
  return { index: 1, query: "q", expect: [], expect_any: [], forbid: [], none: false, ...part };
}

function run(loaded: string[], text = ""): RunResult {
  return {
    loaded, text, costUsd: null, availableSkills: null,
    error: null, stoppedEarly: false, durationMs: 0,
  };
}

describe("judge", () => {
  it("passes a matching case", () => {
    const v = judge(makeCase({ expect: ["find-bug"] }), run(["find-bug"]));
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("");
    expect(v.diagnosis).toBeNull();
  });

  it("copies run metadata into the verdict (both branches)", () => {
    const r: RunResult = { ...run(["find-bug"]), stoppedEarly: true, durationMs: 4321 };
    expect(judge(makeCase({ expect: ["find-bug"] }), r)).toMatchObject({ stoppedEarly: true, durationMs: 4321 });
    const err: RunResult = { ...r, error: "boom" };
    expect(judge(makeCase({ expect: ["find-bug"] }), err)).toMatchObject({ stoppedEarly: true, durationMs: 4321 });
  });

  it("expect: reports each missing name", () => {
    const v = judge(makeCase({ expect: ["find-bug", "test-guard"] }), run(["find-bug"]));
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(["not loaded test-guard"]);
  });

  it("expect_any: none loaded", () => {
    const v = judge(makeCase({ expect_any: ["stability", "test-guard"] }), run(["find-bug"]));
    expect(v.reason).toBe("not loaded any of [stability, test-guard]");
    expect(judge(makeCase({ expect_any: ["stability", "test-guard"] }), run(["stability"])).ok).toBe(true);
  });

  it("forbid: each present name", () => {
    const v = judge(makeCase({ forbid: ["find-bug", "other-skill"] }), run(["find-bug", "other-skill"]));
    expect(v.reasons).toEqual(["forbidden find-bug", "forbidden other-skill"]);
  });

  it("first: wrong order", () => {
    const v = judge(makeCase({ first: "test-guard" }), run(["find-bug", "test-guard"]));
    expect(v.reason).toBe("loaded find-bug first, expected test-guard");
  });

  it("first: nothing loaded", () => {
    const v = judge(makeCase({ first: "find-bug" }), run([]));
    expect(v.reason).toBe("nothing loaded, expected find-bug first");
    expect(judge(makeCase({ first: "find-bug" }), run(["find-bug"])).ok).toBe(true);
  });

  it("none: something loaded", () => {
    const v = judge(makeCase({ none: true }), run(["find-bug", "test-guard"]));
    expect(v.reason).toBe("expected nothing, loaded [find-bug, test-guard]");
  });

  it("caps reason at two and dedupes reasons", () => {
    const v = judge(makeCase({ expect: ["a", "a", "b", "c"] }), run([]));
    expect(v.reasons).toEqual(["not loaded a", "not loaded b", "not loaded c"]); // deduped
    expect(v.reason).toBe("not loaded a; not loaded b"); // capped at two

    const v2 = judge(makeCase({ expect: ["x"], forbid: ["y", "z"] }), run(["y", "z"]));
    expect(v2.reasons).toEqual(["not loaded x", "forbidden y", "forbidden z"]);
    expect(v2.reason).toBe("not loaded x; forbidden y");
  });

  it("diagnosis when nothing loaded but text names the skill", () => {
    const v = judge(makeCase({ expect: ["find-bug"] }), run([], "Use the Find-Bug skill for this"));
    expect(v.ok).toBe(false);
    expect(v.diagnosis).toBe(DIAGNOSIS);

    const vAny = judge(makeCase({ expect_any: ["test-guard"] }), run([], "test-guard fits"));
    expect(vAny.diagnosis).toBe(DIAGNOSIS);
  });

  it("no diagnosis when something was loaded or text is silent", () => {
    expect(judge(makeCase({ expect: ["find-bug"] }), run(["other-skill"], "find-bug")).diagnosis).toBeNull();
    expect(judge(makeCase({ expect: ["find-bug"] }), run([], "nothing relevant")).diagnosis).toBeNull();
  });

  it("run error short-circuits", () => {
    const r: RunResult = { ...run(["find-bug"]), error: "timeout after 180s", costUsd: 0.5 };
    const v = judge(makeCase({ expect: ["find-bug"] }), r);
    expect(v).toMatchObject({ ok: false, reasons: ["timeout after 180s"], diagnosis: null, costUsd: 0.5, error: "timeout after 180s" });
  });
});

describe("aggregate", () => {
  const verdict = (ok: boolean) => ({
    ok, reasons: ok ? [] : ["x"], reason: ok ? "" : "x", loaded: [] as string[],
    diagnosis: null, costUsd: null, error: null, stoppedEarly: false, durationMs: 0,
  });

  it("2/3 passes threshold 0.6", () => {
    const res = aggregate(makeCase({}), [verdict(true), verdict(true), verdict(false)], 0.6);
    expect(res.passed).toBe(2);
    expect(res.ok).toBe(true);
    expect(res.threshold).toBe(0.6);
  });

  it("2/3 fails threshold 1.0", () => {
    expect(aggregate(makeCase({}), [verdict(true), verdict(true), verdict(false)], 1.0).ok).toBe(false);
  });

  it("float threshold 1/3 of 1/3 passes", () => {
    expect(aggregate(makeCase({}), [verdict(true), verdict(false), verdict(false)], 1 / 3).ok).toBe(true);
  });

  it("no runs never passes", () => {
    expect(aggregate(makeCase({}), [], 0.5).ok).toBe(false);
  });
});
