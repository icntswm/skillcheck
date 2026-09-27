import { describe, expect, it } from "vitest";
import { BATCH_SCHEMA, buildBatchPrompt, parseBatchAnswer } from "../src/batch.js";

describe("buildBatchPrompt", () => {
  it("numbers requests by n and quotes queries as JSON string literals", () => {
    const prompt = buildBatchPrompt([
      { n: 1, query: 'почему падает "stability" test' },
      { n: 2, query: "line one\nline two" },
    ]);
    const lines = prompt.split("\n");
    expect(lines[0]).toContain("Below are 2 independent user requests");
    expect(lines.at(-2)).toBe(`1. ${JSON.stringify('почему падает "stability" test')}`);
    expect(lines.at(-1)).toBe(`2. ${JSON.stringify("line one\nline two")}`);
    // a newline inside a query stays escaped, so the list cannot be broken
    expect(prompt).not.toContain(`\nline two`);
  });

  it("keeps the survey wording that forbids acting on the requests", () => {
    const prompt = buildBatchPrompt([{ n: 1, query: "q" }]);
    expect(prompt).toContain("[SKILL ROUTING SURVEY]");
    expect(prompt).toContain("Do not load any skill");
    expect(prompt).toContain("Requests:");
  });
});

describe("BATCH_SCHEMA", () => {
  it("describes an answers array of {n, skills} objects", () => {
    expect(BATCH_SCHEMA).toEqual({
      type: "object",
      properties: {
        answers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              n: { type: "integer" },
              skills: { type: "array", items: { type: "string" } },
            },
            required: ["n", "skills"],
          },
        },
      },
      required: ["answers"],
    });
  });
});

describe("parseBatchAnswer", () => {
  const ok = { answers: [{ n: 1, skills: ["find-bug"] }, { n: 2, skills: [] }] };

  it("takes the structured output when it has an answers array", () => {
    const { answers, error } = parseBatchAnswer(ok, "ignored text");
    expect(error).toBeNull();
    expect(answers.get(1)).toEqual(["find-bug"]);
    expect(answers.get(2)).toEqual([]);
    expect(answers.has(3)).toBe(false);
  });

  it("falls back to the last balanced object in the text", () => {
    const { answers, error } = parseBatchAnswer(null, `prose { "answers": [] } then {"answers":[{"n":1,"skills":["a"]}]} tail`);
    expect(error).toBeNull();
    expect(answers.get(1)).toEqual(["a"]); // last wins
  });

  it("does not confuse braces inside JSON strings", () => {
    const text = `answer: {"answers":[{"n":1,"skills":["}"]}]} — done }`;
    const { answers, error } = parseBatchAnswer(null, text);
    expect(error).toBeNull();
    expect(answers.get(1)).toEqual(["}"]);
  });

  it("ignores entries whose n is not an integer", () => {
    const { answers, error } = parseBatchAnswer({ answers: [{ n: "1", skills: ["x"] }, { n: 2.5, skills: ["y"] }, { n: 3, skills: ["z"] }] }, "");
    expect(error).toBeNull();
    expect([...answers.keys()]).toEqual([3]);
  });

  it("cleans skill names: trims, strips leading /, drops none and empties, dedupes", () => {
    const { answers } = parseBatchAnswer({ answers: [{ n: 1, skills: ["  /find-bug ", "none", "", "  ", "find-bug", "stability", "test-guard"] }] }, "");
    expect(answers.get(1)).toEqual(["find-bug", "stability", "test-guard"]);
  });

  it("treats a non-array skills field as empty", () => {
    expect(parseBatchAnswer({ answers: [{ n: 1, skills: "find-bug" }] }, "").answers.get(1)).toEqual([]);
  });

  it("reports an error when nothing is parseable", () => {
    const r = parseBatchAnswer({}, "I would load find-bug, no JSON here");
    expect(r.answers.size).toBe(0);
    expect(r.error).toBe("batch answer is not valid JSON");
    expect(parseBatchAnswer(null, "")).toEqual({ answers: new Map(), error: "batch answer is not valid JSON" });
    expect(parseBatchAnswer(null, "{ broken").error).toBe("batch answer is not valid JSON");
  });
});
