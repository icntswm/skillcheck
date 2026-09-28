import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfigError, findDefaultCasesFile, knownSkillNames, loadSuite,
  parseSuite, unknownNames,
} from "../src/cases.js";

function errorsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.errors;
    throw e;
  }
  throw new Error("expected ConfigError");
}

const validCase = { query: "q1", expect: ["find-bug"] };

describe("parseSuite", () => {
  it("accepts the legacy bare array", () => {
    const suite = parseSuite([validCase, { query: "q2", none: true }]);
    expect(suite.agent).toBe("claude");
    expect(suite.repeat).toBe(1);
    expect(suite.threshold).toBe(1.0);
    expect(suite.model).toBeUndefined();
    expect(suite.cases.map((c) => c.index)).toEqual([1, 2]);
    expect(suite.cases[1]?.none).toBe(true);
  });

  it("accepts the object format with suite fields", () => {
    const suite = parseSuite({
      agent: "claude", model: "sonnet", repeat: 3, threshold: 0.6,
      cases: [{ ...validCase, id: "c1", repeat: 5, threshold: 1, agents: ["claude"], note: "n", first: "find-bug" }],
    });
    expect(suite.model).toBe("sonnet");
    expect(suite.repeat).toBe(3);
    expect(suite.threshold).toBe(0.6);
    expect(suite.cases[0]).toMatchObject({ id: "c1", repeat: 5, threshold: 1, agents: ["claude"] });
  });

  it("rejects empty files and wrong top-level shapes", () => {
    expect(errorsOf(() => parseSuite([]))).toContain("no cases");
    expect(errorsOf(() => parseSuite("x"))).length(1);
    expect(errorsOf(() => parseSuite(null))).length(1);
  });

  it("top level: unknown keys, missing/empty cases, bad field types", () => {
    expect(errorsOf(() => parseSuite({ foo: 1 }))).toEqual([
      'unknown key "foo"', "cases is required",
    ]);
    expect(errorsOf(() => parseSuite({ cases: [] }))).toContain("cases must be a non-empty array");
    expect(errorsOf(() => parseSuite({ cases: "nope" }))).toContain("cases must be a non-empty array");
    expect(errorsOf(() => parseSuite({ agent: 7, cases: [validCase] }))).toContain("agent must be a string");
    expect(errorsOf(() => parseSuite({ model: 7, cases: [validCase] }))).toContain("model must be a string");
    expect(errorsOf(() => parseSuite({ repeat: 0, cases: [validCase] }))).toContain("repeat must be an integer >= 1");
    expect(errorsOf(() => parseSuite({ threshold: 0, cases: [validCase] }))).toContain("threshold must be a number with 0 < x <= 1");
    expect(errorsOf(() => parseSuite({ threshold: 1.5, cases: [validCase] }))).length(1);
  });

  it("case level: unknown key is index-prefixed", () => {
    const errors = errorsOf(() => parseSuite({
      cases: [validCase, validCase, { ...validCase, foo: 1 }],
    }));
    expect(errors).toContain('#3: unknown key "foo"');
  });

  it("case level: field type errors", () => {
    const check = (part: object, expected: string) =>
      expect(errorsOf(() => parseSuite([part]))).toContain(expected);
    check({ expect: ["find-bug"] }, "#1: query is required");
    check({ query: "", expect: ["find-bug"] }, "#1: query must be a non-empty string");
    check({ query: "q" }, "#1: at least one of expect, expect_any, forbid, first, none is required");
    check({ query: "q", expect: "find-bug" }, "#1: expect must be an array of non-empty strings");
    check({ query: "q", expect_any: [""] }, "#1: expect_any must be an array of non-empty strings");
    check({ query: "q", forbid: [7] }, "#1: forbid must be an array of non-empty strings");
    check({ query: "q", agents: [true] }, "#1: agents must be an array of non-empty strings");
    check({ query: "q", first: 5 }, "#1: first must be a string");
    check({ query: "q", note: 5 }, "#1: note must be a string");
    check({ query: "q", id: 5 }, "#1: id must be a string");
    check({ query: "q", none: "yes" }, "#1: none must be a boolean");
    check({ query: "q", expect: ["d"], repeat: 1.5 }, "#1: repeat must be an integer >= 1");
    check({ query: "q", expect: ["d"], threshold: 0 }, "#1: threshold must be a number with 0 < x <= 1");
    check([validCase], "#1: case must be an object");
  });

  it("contradictions", () => {
    expect(errorsOf(() => parseSuite([{ query: "q", none: true, expect: ["a"] }])))
      .toContain("#1: none: true contradicts expect/expect_any/first");
    expect(errorsOf(() => parseSuite([{ query: "q", none: true, first: "a" }])))
      .toContain("#1: none: true contradicts expect/expect_any/first");
    expect(errorsOf(() => parseSuite([{ query: "q", expect: ["a"], forbid: ["a"] }]))
      .some((e) => e.includes('"a"') && e.includes("forbidden"))).toBe(true);
    expect(errorsOf(() => parseSuite([{ query: "q", first: "b", forbid: ["b"] }]))).length(1);
    expect(errorsOf(() => parseSuite([{ query: "q", expect_any: ["c"], forbid: ["c"] }]))).length(1);
  });

  it("none: true alone is valid", () => {
    expect(parseSuite([{ query: "q", none: true }]).cases[0]?.none).toBe(true);
  });

  it("duplicate ids", () => {
    const errors = errorsOf(() => parseSuite([
      { query: "a", id: "x", expect: ["d"] },
      { query: "b", id: "x", expect: ["d"] },
    ]));
    expect(errors).toContain('#2: duplicate id "x"');
  });

  it("collects several errors at once", () => {
    const errors = errorsOf(() => parseSuite([
      { query: "ok", expect: ["d"] },
      { nope: 1 },
      { query: "q", expect: "x" },
    ]));
    expect(errors).toContain('#2: query is required');
    expect(errors).toContain('#2: at least one of expect, expect_any, forbid, first, none is required');
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillcheck-cases-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadSuite", () => {
  it("reads YAML and JSON files", async () => {
    const yamlPath = path.join(tmp, "cases.yaml");
    fs.writeFileSync(yamlPath, "agent: claude\nrepeat: 2\ncases:\n  - query: why does it fail\n    expect: [find-bug]\n    forbid: [test-guard]\n");
    const suite = await loadSuite(yamlPath);
    expect(suite.repeat).toBe(2);
    expect(suite.cases[0]?.expect).toEqual(["find-bug"]);

    const jsonPath = path.join(tmp, "cases.json");
    fs.writeFileSync(jsonPath, JSON.stringify([{ query: "q", none: true }]));
    expect((await loadSuite(jsonPath)).cases[0]?.none).toBe(true);

    fs.writeFileSync(path.join(tmp, "cases.yml"), "cases:\n  - query: q\n    first: find-bug\n");
    expect((await loadSuite(path.join(tmp, "cases.yml"))).cases[0]?.first).toBe("find-bug");
  });

  it("wraps read and parse failures in ConfigError", async () => {
    await expect(loadSuite(path.join(tmp, "missing.yaml"))).rejects.toThrow(ConfigError);
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{oops");
    await expect(loadSuite(bad)).rejects.toThrow(/cannot parse/);
    const ybad = path.join(tmp, "bad.yaml");
    fs.writeFileSync(ybad, "cases: [\n  {query:\n");
    await expect(loadSuite(ybad)).rejects.toThrow(ConfigError);
    const txt = path.join(tmp, "cases.txt");
    fs.writeFileSync(txt, "cases: []");
    await expect(loadSuite(txt)).rejects.toThrow(/unsupported file format/);
  });

  it("findDefaultCasesFile prefers yaml, then yml, then json", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "default-"));
    expect(findDefaultCasesFile(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, "skillcheck.json"), "[]");
    expect(findDefaultCasesFile(dir)).toBe(path.join(dir, "skillcheck.json"));
    fs.writeFileSync(path.join(dir, "skillcheck.yml"), "");
    expect(findDefaultCasesFile(dir)).toBe(path.join(dir, "skillcheck.yml"));
    fs.writeFileSync(path.join(dir, "skillcheck.yaml"), "");
    expect(findDefaultCasesFile(dir)).toBe(path.join(dir, "skillcheck.yaml"));
  });
});

describe("knownSkillNames", () => {
  it("scans skills dirs (following symlinks) and top-level command files", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const root = path.join(home, ".claude");
    const realTarget = fs.mkdtempSync(path.join(tmp, "target-"));
    const linked = path.join(realTarget, "linked-skill");
    fs.mkdirSync(path.join(linked, "x"), { recursive: true });
    fs.writeFileSync(path.join(linked, "SKILL.md"), "# s");
    fs.mkdirSync(path.join(root, "skills", "plain-skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "plain-skill", "SKILL.md"), "# s");
    fs.mkdirSync(path.join(root, "skills", "no-md"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "broken-link"), { recursive: true });
    fs.symlinkSync(linked, path.join(root, "skills", "via-symlink"), "dir");
    fs.mkdirSync(path.join(root, "commands"), { recursive: true });
    fs.writeFileSync(path.join(root, "commands", "build.md"), "# c");
    fs.mkdirSync(path.join(root, "commands", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "commands", "nested", "deep.md"), "# c");
    fs.writeFileSync(path.join(root, "commands", "notes.txt"), "x");

    const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
    fs.mkdirSync(path.join(cwd, ".claude", "skills", "project-skill"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "project-skill", "SKILL.md"), "# s");

    const names = knownSkillNames({ home, cwd });
    expect(names.has("plain-skill")).toBe(true);
    expect(names.has("via-symlink")).toBe(true);
    expect(names.has("no-md")).toBe(false);
    expect(names.has("build")).toBe(true);
    expect(names.has("deep")).toBe(false);
    expect(names.has("notes")).toBe(false);
    expect(names.has("project-skill")).toBe(true);
    expect(names.has("code-review")).toBe(true); // built-ins
    expect(names.has("run")).toBe(true);
  });

  it("honors CLAUDE_CONFIG_DIR", () => {
    const custom = fs.mkdtempSync(path.join(tmp, "custom-config-"));
    fs.mkdirSync(path.join(custom, "skills", "env-skill"), { recursive: true });
    fs.writeFileSync(path.join(custom, "skills", "env-skill", "SKILL.md"), "# s");
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = custom;
    try {
      expect(knownSkillNames({ cwd: tmp }).has("env-skill")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("configDir takes precedence over CLAUDE_CONFIG_DIR", () => {
    const envCfg = fs.mkdtempSync(path.join(tmp, "envcfg-"));
    const optCfg = fs.mkdtempSync(path.join(tmp, "optcfg-"));
    fs.mkdirSync(path.join(envCfg, "skills", "env-skill"), { recursive: true });
    fs.writeFileSync(path.join(envCfg, "skills", "env-skill", "SKILL.md"), "# s");
    fs.mkdirSync(path.join(optCfg, "skills", "opt-skill"), { recursive: true });
    fs.writeFileSync(path.join(optCfg, "skills", "opt-skill", "SKILL.md"), "# s");
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = envCfg;
    try {
      const names = knownSkillNames({ home: fs.mkdtempSync(path.join(tmp, "empty-home-")), cwd: tmp, configDir: optCfg });
      expect(names.has("opt-skill")).toBe(true);
      expect(names.has("env-skill")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("includes the skills seen in a clean config's init event", () => {
    const names = knownSkillNames({ home: fs.mkdtempSync(path.join(tmp, "no-home-")), cwd: fs.mkdtempSync(path.join(tmp, "no-cwd-")) });
    for (const name of ["deep-research", "design-sync", "dataviz", "verify", "debug", "batch", "doctor", "workflow-authoring", "run-skill-generator"]) {
      expect(names.has(name)).toBe(true);
    }
    expect(names.has("code-review")).toBe(true); // the old names stayed
  });
});

describe("unknownNames", () => {
  it("flags unknown names per field and skips plugin names", () => {
    const suite = parseSuite({
      cases: [
        { query: "a", expect: ["find-bug", "nope"], forbid: ["ghost"], id: "x" },
        { query: "b", first: "gone", expect_any: ["myplugin:thing", "also-unknown"] },
      ],
    });
    const known = new Set(["find-bug", "nope"]);
    expect(unknownNames(suite, known)).toEqual([
      '#1: unknown skill "ghost" in forbid',
      '#2: unknown skill "also-unknown" in expect_any',
      '#2: unknown skill "gone" in first',
    ]);
  });

  it("checks names for source plugins but preserves the installed-plugin skip", () => {
    const suite = parseSuite({ cases: [
      { query: "typo", expect: ["p:typo"] },
      { query: "known", expect: ["p:skill"] },
      { query: "installed", expect: ["other:x"] },
    ] });
    expect(unknownNames(suite, new Set(["p:skill"]), new Set(["p"]))).toEqual([
      '#1: unknown skill "p:typo" in expect',
    ]);
    expect(unknownNames(suite, new Set(["p:skill"]))).toEqual([]);
  });
});
