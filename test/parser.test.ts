import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeStream, DEFAULT_DIRECTIVE, parseClaudeStream } from "../src/agents/claude.js";
import { inputEquivalent } from "../src/budget.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(fixtures, name), "utf8").split("\n").filter((l) => l !== "");
}

function pushAll(lines: string[]): boolean[] {
  const stream = new ClaudeStream();
  return lines.map((l) => stream.push(l));
}

function parseFixture(name: string) {
  return parseClaudeStream(fixtureLines(name).join("\n"));
}

describe("ClaudeStream", () => {
  it("collects skills in first-seen order, strips leading /, dedupes", () => {
    const r = parseFixture("synthetic-two-skills.jsonl");
    expect(r.loaded).toEqual(["a", "b"]);
    expect(r.availableSkills).toEqual(["a", "b", "c"]);
    expect(r.costUsd).toBeCloseTo(0.05, 10);
    expect(r.text).toBe("answer text"); // result wins over assistant text
  });

  it("dedupes repeated and /-prefixed names", () => {
    const r = parseFixture("synthetic-repeat.jsonl");
    expect(r.loaded).toEqual(["a"]);
  });

  it("tolerates garbage lines and ignores non-JSON or indented ones", () => {
    const r = parseFixture("synthetic-garbage.jsonl");
    expect(r.loaded).toEqual(["test-guard"]);
    expect(r.availableSkills).toEqual(["test-guard", "find-bug"]);
    expect(r.text).toBe("test-guard it is");
    expect(r.costUsd).toBeCloseTo(0.02, 10);
  });

  it("handles empty stdout", () => {
    const r = parseClaudeStream("");
    expect(r.loaded).toEqual([]);
    expect(r.text).toBe("");
    expect(r.costUsd).toBeNull();
    expect(r.availableSkills).toBeNull();
  });

  it("falls back to joined assistant text when no result event", () => {
    const stream = new ClaudeStream();
    stream.push('{"type":"assistant","message":{"content":[{"type":"text","text":"one"}]}}');
    stream.push('{"type":"assistant","message":{"content":[{"type":"text","text":"two"}]}}');
    expect(stream.result.text).toBe("one\ntwo");
  });

  it("falls back to assistant text when result is an empty string", () => {
    const stream = new ClaudeStream();
    stream.push('{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}');
    stream.push('{"type":"result","subtype":"success","result":""}');
    expect(stream.result.text).toBe("partial");
  });

  it("uses input.command and input.name fallbacks", () => {
    const stream = new ClaudeStream();
    stream.push('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"command":"/cmd-skill"}}]}}');
    stream.push('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{}}]}}');
    stream.push('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Other","input":{"skill":"no"}}]}}');
    stream.push('{"type":"result","result":"x","total_cost_usd":"not-a-number"}');
    expect(stream.result.loaded).toEqual(["cmd-skill"]); // empty name skipped, non-Skill tool skipped
    expect(stream.result.costUsd).toBeNull();
  });

  it("signals stop on the assistant event after a Skill event", () => {
    const stops = pushAll(fixtureLines("synthetic-two-skills.jsonl"));
    // init, Skill(a), Skill(b), text, result
    expect(stops).toEqual([false, false, false, true, true]);
  });

  it("two Skill events in a row do not stop; Skill then result stops", () => {
    const stops = pushAll(fixtureLines("synthetic-repeat.jsonl"));
    expect(stops[1]).toBe(false);
    expect(stops[2]).toBe(false);
    expect(stops[3]).toBe(false);
    expect(stops[4]).toBe(true);
  });

  it("assistant text before any Skill does not stop", () => {
    const stops = pushAll([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking out loud"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"a"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
    ]);
    expect(stops).toEqual([false, false, true]);
  });

  it("keeps structured_output from the result event", () => {
    const r = parseFixture("synthetic-batch.jsonl");
    expect(r.structuredOutput).toEqual({ answers: [{ n: 1, skills: ["find-bug"] }, { n: 2, skills: [] }] });
    expect(r.text).toBe("Here is the survey answer.");
    expect(r.costUsd).toBeCloseTo(0.06, 10);
  });

  it("structured output is null when the result event has none", () => {
    expect(parseFixture("synthetic-garbage.jsonl").structuredOutput).toBeNull();
    expect(parseClaudeStream("").structuredOutput).toBeNull();
  });

  it("DEFAULT_DIRECTIVE mentions the routing check", () => {
    expect(DEFAULT_DIRECTIVE).toContain("[SKILL ROUTING CHECK]");
    expect(DEFAULT_DIRECTIVE).toContain('answer "none"');
  });
});

const skillFixture = path.join(fixtures, "claude-skill.jsonl");
const noneFixture = path.join(fixtures, "claude-none.jsonl");

// real recorded runs, gitignored: skip when absent
describe.skipIf(!existsSync(skillFixture))("recorded run: skill", () => {
  it("parses the real stream", () => {
    const r = parseFixture("claude-skill.jsonl");
    expect(r.loaded).toHaveLength(1);
    expect(r.costUsd).toBeCloseTo(0.169, 3);
    expect(r.availableSkills?.length).toBeGreaterThan(0);
  });

  it("stops at the thinking event right after Skill, before any Glob", () => {
    const lines = fixtureLines("claude-skill.jsonl");
    const stream = new ClaudeStream();
    let stopIndex = -1;
    lines.forEach((line, i) => {
      if (stopIndex === -1 && stream.push(line)) stopIndex = i;
    });
    expect(stopIndex).toBeGreaterThan(-1);
    expect(lines[stopIndex]).toContain('"type":"thinking"');
    const globIndex = lines.findIndex((l) => l.includes('"name":"Glob"'));
    expect(globIndex).toBeGreaterThan(stopIndex);
  });
});

describe.skipIf(!existsSync(noneFixture))("recorded run: none", () => {
  it("parses the real stream", () => {
    const r = parseFixture("claude-none.jsonl");
    expect(r.loaded).toEqual([]);
    expect(r.text.toLowerCase()).toMatch(/^none/);
    expect(r.costUsd).toBeCloseTo(0.0762, 3);
  });
});

describe("ClaudeStream error", () => {
  const result = (fields: Record<string, unknown>) => JSON.stringify({ type: "result", ...fields });

  it("reports an error result other than error_max_turns", () => {
    const stream = new ClaudeStream();
    stream.push(result({ subtype: "success", is_error: true, result: "You've hit your session limit · resets 4am" }));
    expect(stream.error).toBe("claude error: You've hit your session limit · resets 4am");
  });

  it("treats error_max_turns as a normal end", () => {
    const stream = new ClaudeStream();
    stream.push(result({ subtype: "error_max_turns", is_error: true, result: "" }));
    expect(stream.error).toBeNull();
  });

  it("treats error_max_structured_output_retries as an error", () => {
    const stream = new ClaudeStream();
    stream.push(result({ subtype: "error_max_structured_output_retries", is_error: true, result: "" }));
    expect(stream.error).toBe("claude error: error_max_structured_output_retries");
  });

  it("falls back to the subtype when the error has no text", () => {
    const stream = new ClaudeStream();
    stream.push(result({ subtype: "error_during_execution", is_error: true }));
    expect(stream.error).toBe("claude error: error_during_execution");
  });
});

describe("ClaudeStream init", () => {
  it("merges skills and slash_commands", () => {
    const stream = new ClaudeStream();
    stream.push(JSON.stringify({ type: "system", subtype: "init", skills: ["find-bug", "test-guard"], slash_commands: ["test-guard", "stability"] }));
    expect(stream.result.availableSkills).toEqual(["find-bug", "test-guard", "stability"]);
  });

  it("keeps the raw lists apart and flags sawInit", () => {
    const stream = new ClaudeStream();
    expect(stream.sawInit).toBe(false);
    expect(stream.initSkills).toBeNull();
    expect(stream.initSlashCommands).toBeNull();
    stream.push(JSON.stringify({ type: "system", subtype: "init", skills: ["b", "a"], slash_commands: ["a", "commit"] }));
    expect(stream.sawInit).toBe(true);
    expect(stream.initSkills).toEqual(["b", "a"]); // raw order, not the union
    expect(stream.initSlashCommands).toEqual(["a", "commit"]);
  });

  it("init only in one list leaves the other null-safe", () => {
    const stream = new ClaudeStream();
    stream.push('{"type":"system","subtype":"init","skills":["a"]}');
    expect(stream.initSkills).toEqual(["a"]);
    expect(stream.initSlashCommands).toBeNull();
    expect(stream.result.availableSkills).toEqual(["a"]);
  });

  it("init event alone does not signal a stop", () => {
    const stream = new ClaudeStream();
    expect(stream.push('{"type":"system","subtype":"init","skills":["a"]}')).toBe(false);
  });

  it("usage of a finished run comes from the result event and prices like total_cost_usd", () => {
    for (const name of ["claude-skill.jsonl", "claude-none.jsonl"]) {
      const stream = new ClaudeStream();
      let cost = 0;
      for (const line of fixtureLines(name)) {
        stream.push(line);
        if (line.includes('"type":"result"')) cost = (JSON.parse(line) as { total_cost_usd: number }).total_cost_usd;
      }
      // claude-sonnet-5 input is $2/M; the fixed ratios reproduce the real bill
      expect(inputEquivalent(stream.usage!) * 2e-6).toBeCloseTo(cost, 6);
    }
  });

  it("usage of a killed run sums assistant messages, each message once", () => {
    const stream = new ClaudeStream();
    for (const line of fixtureLines("claude-skill.jsonl")) {
      if (line.includes('"type":"result"')) break;
      stream.push(line);
    }
    expect(stream.finished).toBe(false);
    expect(stream.usage).toEqual({
      model: "claude-sonnet-5", input: 6, output: 9, cacheRead: 68875, cacheWrite5m: 0, cacheWrite1h: 35254,
    });
  });

  it("no assistant usage means no usage", () => {
    expect(new ClaudeStream().usage).toBeNull();
  });
});
