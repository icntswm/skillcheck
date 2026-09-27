import { describe, expect, it } from "vitest";
import { parseSuite, type Suite } from "../src/cases.js";
import type { SkillDoc } from "../src/describe.js";
import { lint, LINT_DEFAULTS, type LintOptions } from "../src/lint.js";

function doc(name: string, description: string, kind: "skill" | "command" = "skill", plugin: string | null = null): SkillDoc {
  return { name, kind, file: `/x/${name}`, description, plugin };
}

function suite(cases: unknown[]): Suite {
  return parseSuite({ cases });
}

const opts = (over: Partial<LintOptions> = {}): LintOptions => ({ ...LINT_DEFAULTS, ...over });

const ALPHA = "crash stack trace fails debugging errors";
const BETA = "pasta recipe soup bread cooking kitchen";
const GAMMA = "kubernetes helm charts deploy cluster pods";
const DOCS = [doc("alpha", ALPHA), doc("beta", BETA), doc("gamma", GAMMA)];

describe("lint short", () => {
  it("flags descriptions below minLength and keeps the boundary", () => {
    const exact = "x".repeat(20);
    const docs = [...DOCS, doc("tiny", "ten chars!!"), doc("exact", exact)];
    const report = lint(docs, null, opts({ minLength: 20 }));
    expect(report.short).toEqual([{ name: "tiny", kind: "skill", length: 11 }]);
    expect(report.docs).toBe(5);
    expect(report.cases).toBe(0);
  });

  it("counts commands as kind command", () => {
    const report = lint([doc("build", "short", "command")], null, opts());
    expect(report.short).toEqual([{ name: "build", kind: "command", length: 5 }]);
  });
});

describe("lint similar", () => {
  it("reports pairs at or above the overlap threshold", () => {
    const docs = [doc("ab", ALPHA), doc("cd", ALPHA), doc("ef", GAMMA)];
    const found = lint(docs, null, opts({ minLength: 0 })).similar;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ a: "ab", b: "cd" });
    // the boundary is inclusive: any overlap above the score drops the pair
    const strict = lint(docs, null, opts({ minLength: 0, overlap: found[0]!.score + 0.01 })).similar;
    expect(strict).toEqual([]);
  });
});

describe("lint far", () => {
  const query = "crash stack trace fails"; // matches alpha, nothing else

  it("flags an expected skill ranked below --top", () => {
    const report = lint(DOCS, suite([{ query, expect: ["beta"] }]), opts({ top: 1 }));
    expect(report.far).toEqual([
      { index: 1, id: null, query, expected: "beta", rank: 2, top: ["alpha", "beta", "gamma"] },
    ]);
  });

  it("does not flag rank equal to top", () => {
    expect(lint(DOCS, suite([{ query, expect: ["beta"] }]), opts({ top: 2 })).far).toEqual([]);
  });

  it("ranks expect_any as one a|b target by its best member", () => {
    const report = lint(DOCS, suite([{ query, expect_any: ["beta", "gamma"], id: "x" }]), opts({ top: 1 }));
    expect(report.far).toEqual([
      { index: 1, id: "x", query, expected: "beta|gamma", rank: 2, top: ["alpha", "beta", "gamma"] },
    ]);
  });

  it("adds first only when expect does not already cover it", () => {
    const both = lint(DOCS, suite([{ query, expect: ["alpha"], first: "beta" }]), opts({ top: 1 }));
    expect(both.far.map((f) => f.expected)).toEqual(["beta"]);
    const dupe = lint(DOCS, suite([{ query, expect: ["beta"], first: "beta" }]), opts({ top: 1 }));
    expect(dupe.far).toHaveLength(1);
  });

  it("skips names without a doc, but keeps the full a|b label", () => {
    const single = lint(DOCS, suite([{ query, expect: ["code-review", "myplugin:thing"] }]), opts({ top: 1 }));
    expect(single.far).toEqual([]);
    const mixed = lint(DOCS, suite([{ query, expect_any: ["ghost", "beta"] }]), opts({ top: 1 }));
    expect(mixed.far.map((f) => [f.expected, f.rank])).toEqual([["ghost|beta", 2]]);
  });

  it("ranks x:y names that have a doc", () => {
    // plug:alpha has alpha's text, so it ranks just after alpha itself
    const docs = [...DOCS, doc("plug:alpha", ALPHA, "skill", "plug")];
    const report = lint(docs, suite([{ query, expect: ["plug:alpha"] }]), opts({ top: 1 }));
    expect(report.far.map((f) => [f.expected, f.rank])).toEqual([["plug:alpha", 2]]);
  });

  it("none cases and forbid produce nothing", () => {
    const report = lint(DOCS, suite([{ query, none: true }, { query, forbid: ["beta"] }]), opts({ top: 1 }));
    expect(report.far).toEqual([]);
  });
});

describe("lint uncovered", () => {
  it("lists skills named in no case, excluding commands and counting forbid mentions", () => {
    const docs = [...DOCS.slice(0, 2), doc("delta", "unused skill description"), doc("build", "a command", "command")];
    const cases = [
      { query: "q", expect: ["alpha"] },
      { query: "q", forbid: ["beta"] },
      { query: "q", none: true },
    ];
    const report = lint(docs, suite(cases), opts({ minLength: 0 }));
    expect(report.uncovered).toEqual(["delta"]);
  });

  it("stays empty without a suite", () => {
    expect(lint(DOCS, null, opts({ minLength: 0 })).uncovered).toEqual([]);
  });

  it("excludes plugin skills: they are someone else's", () => {
    const docs = [
      doc("alpha", ALPHA),
      doc("delta", "unused skill description that is long enough"),
      doc("plug:one", "a plugin skill description long enough to pass", "skill", "plug"),
    ];
    const report = lint(docs, suite([{ query: "q", expect: ["alpha"] }]), opts({ minLength: 0 }));
    expect(report.uncovered).toEqual(["delta"]);
  });
});

describe("lint defaults", () => {
  it("treats 0.3 as the overlap threshold", () => {
    expect(LINT_DEFAULTS.overlap).toBe(0.3);
  });
});
