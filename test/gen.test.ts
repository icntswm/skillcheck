import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseSuite } from "../src/cases.js";
import { buildGenPrompt, genSuite, parseGenAnswer, type GenCase } from "../src/gen.js";
import type { SkillDoc } from "../src/describe.js";

function doc(name: string, description: string): SkillDoc {
  return { name, kind: "skill", file: `/tmp/${name}/SKILL.md`, description, plugin: null };
}

describe("gen helpers", () => {
  it("builds a prompt with all names, clipped descriptions, and counts", () => {
    const long = "word ".repeat(100);
    const prompt = buildGenPrompt(
      [doc("alpha", "Use alpha")],
      [doc("alpha", long), doc("beta", "A second skill\nwith two lines")],
      5,
    );

    expect(prompt).toContain("- alpha: " + JSON.stringify(long.slice(0, 300)));
    expect(prompt).toContain("- beta: \"A second skill with two lines\"");
    expect(prompt).toContain("For alpha: write 5 positive requests and 3 near misses");
    expect(prompt).toContain("alpha");
    expect(prompt).toContain("beta");
    expect(prompt).not.toContain(long.slice(0, 301));
  });

  it("keeps valid answers and counts invalid, duplicate, and empty items", () => {
    const answer = {
      cases: [
        { query: "alpha request", skill: "alpha", avoid: null },
        { query: "near alpha", skill: null, avoid: "alpha" },
        { query: "bad unknown", skill: "ghost", avoid: null },
        { query: "both null", skill: null, avoid: null },
        { query: "same", skill: "alpha", avoid: "alpha" },
        { query: "alpha request", skill: "alpha", avoid: null },
        { query: "", skill: "alpha", avoid: null },
        { query: "also bad", skill: "alpha", avoid: "ghost" },
      ],
    };
    expect(parseGenAnswer(answer, new Set(["alpha", "beta"]))).toEqual({
      cases: [
        { query: "alpha request", skill: "alpha", avoid: null },
        { query: "near alpha", skill: null, avoid: "alpha" },
      ],
      dropped: 6,
    });
    expect(parseGenAnswer("garbage", new Set(["alpha"]))).toEqual({ cases: [], dropped: 0 });
    expect(parseGenAnswer({ cases: "nope" }, new Set(["alpha"]))).toEqual({ cases: [], dropped: 0 });
  });

  it("writes a grouped, parseable suite with safe name quoting", () => {
    const cases: GenCase[] = [
      { query: "beta first", skill: "beta", avoid: null },
      { query: "avoid alpha", skill: null, avoid: "alpha" },
      { query: "alpha positive", skill: "alpha", avoid: null },
      { query: "avoid true", skill: null, avoid: "true" },
    ];
    const text = genSuite(cases, { model: "sonnet", skills: ["alpha", "beta", "true"] });
    const suite = parseSuite(parseYaml(text));
    expect(suite.cases.map((item) => item.query)).toEqual(["avoid alpha", "alpha positive", "beta first", "avoid true"]);
    expect(text).toContain("model: sonnet");
    expect(text).toContain("for: alpha, beta, true.");
    expect(text).toContain('forbid: ["true"]');
  });
});
