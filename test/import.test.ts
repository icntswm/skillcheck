import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ConfigError, parseSuite } from "../src/cases.js";
import { evalSetToSuite } from "../src/import.js";

describe("evalSetToSuite", () => {
  it("turns should_trigger into expect or forbid, keeping the order", () => {
    const { text, positive, negative } = evalSetToSuite(
      [
        { query: "fill this pdf form", should_trigger: true },
        { query: "merge two pdfs", should_trigger: false, note: "extra keys are ignored" },
        { query: "which fields does this form have", should_trigger: true },
      ],
      "pdf-forms",
      "/some/dir/eval_set.json",
    );
    expect(positive).toBe(2);
    expect(negative).toBe(1);
    expect(text).toContain("imported from eval_set.json");
    expect(text).not.toContain("/some/dir");
    const suite = parseSuite(parseYaml(text));
    expect(suite.agent).toBe("claude");
    expect(suite.cases.map((c) => [c.query, c.expect, c.forbid])).toEqual([
      ["fill this pdf form", ["pdf-forms"], []],
      ["merge two pdfs", [], ["pdf-forms"]],
      ["which fields does this form have", ["pdf-forms"], []],
    ]);
  });

  it("keeps tricky queries exactly", () => {
    const queries = [
      'say "hi" and \'bye\'',
      "line one\nline two\ttabbed",
      "# not a comment",
      "key: value - [a, b] {c} & *ref !tag %",
      "проверь PDF 📄 \\ backslash",
      "  leading and trailing  ",
    ];
    const { text } = evalSetToSuite(queries.map((query) => ({ query, should_trigger: true })), "x", "e.json");
    expect(parseSuite(parseYaml(text)).cases.map((c) => c.query)).toEqual(queries);
  });

  it("quotes a skill name that is not plain", () => {
    const { text } = evalSetToSuite([{ query: "q", should_trigger: false }], "my skill", "e.json");
    expect(text).toContain('forbid: ["my skill"]');
    expect(parseSuite(parseYaml(text)).cases[0]?.forbid).toEqual(["my skill"]);
  });

  it.each(["true", "null", "123", "1.5", "~"])("quotes %s, which YAML would not read as a string", (skill) => {
    const { text } = evalSetToSuite([{ query: "q", should_trigger: true }], skill, "e.json");
    expect(text).toContain(`expect: ["${skill}"]`);
    expect(parseSuite(parseYaml(text)).cases[0]?.expect).toEqual([skill]);
  });

  it("keeps a plugin-qualified name plain", () => {
    const { text } = evalSetToSuite([{ query: "q", should_trigger: true }], "plugin:skill-a", "e.json");
    expect(text).toContain("expect: [plugin:skill-a]");
  });

  it.each([
    ["an object", { query: "q", should_trigger: true }],
    ["an empty array", []],
    ["null", null],
  ])("rejects %s at the top level", (_what, data) => {
    expect(() => evalSetToSuite(data, "x", "e.json")).toThrow("expected a JSON array of {query, should_trigger}");
  });

  it("collects every item error", () => {
    let error: unknown;
    try {
      evalSetToSuite(
        [
          { query: "fine", should_trigger: true },
          "just a string",
          { query: "  ", should_trigger: false },
          { query: "q", should_trigger: "true" },
          {},
        ],
        "x",
        "e.json",
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).errors).toEqual([
      "item 2: expected an object with query and should_trigger",
      "item 3: query must be a non-empty string",
      "item 4: should_trigger must be true or false",
      "item 5: query must be a non-empty string",
      "item 5: should_trigger must be true or false",
    ]);
  });
});
