import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/agents/types.js";
import type { Case } from "../src/cases.js";
import { aggregate, judge, type RunVerdict } from "../src/judge.js";
import { toJunit } from "../src/junit.js";
import { buildReport, type ReportCase } from "../src/results.js";

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

function makeReport(cases: ReportCase[], model: string | null = "sonnet"): string {
  return toJunit(buildReport({
    file: "skillcheck.yaml", agent: "claude", model,
    startedAtMs: Date.parse("2026-09-27T10:00:00Z"), durationMs: 12345,
    cases, unavailable: [], confusion: [], budgetUsd: null, budgetReached: false,
  }));
}

describe("toJunit", () => {
  const c1 = kase();
  const c2 = kase({ index: 2, id: "stability", query: "multi\nline   query", expect: ["find-bug"], note: "watch for false positives" });
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

  it("writes header, counts and testcase lines", () => {
    const xml = sample();
    expect(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")).toBe(true);
    expect(xml).toContain("<testsuites name=\"skillcheck\" tests=\"4\" failures=\"1\" errors=\"1\" time=\"12.345\">");
    expect(xml).toContain("<testsuite name=\"skillcheck.claude\" tests=\"4\" failures=\"1\" errors=\"1\" skipped=\"1\" time=\"12.345\" timestamp=\"2026-09-27T10:00:00.000Z\">");
    expect(xml).toContain("<property name=\"agent\" value=\"claude\"/>");
    expect(xml).toContain("<property name=\"model\" value=\"sonnet\"/>");
    expect(xml).toContain("<property name=\"costUsd\" value=\"0.04\"/>");
    expect(xml).toContain("<testcase name=\"#1 why does it fail\" classname=\"skillcheck.claude\" time=\"2\"/>");
    expect(xml).toContain("<testcase name=\"#stability multi line query\" classname=\"skillcheck.claude\" time=\"2\">");
    expect(xml.endsWith("</testsuite>\n</testsuites>\n")).toBe(true);
    expect(xml).not.toContain("unknownCostRuns");
  });

  it("marks runs without a reported cost next to costUsd", () => {
    const xml = makeReport([
      done(c1, [verdict(c1, { loaded: ["find-bug"], costUsd: null })]),
      done(c3, [verdict(c3, { loaded: ["find-bug"] })]),
    ]);
    expect(xml).toContain("<property name=\"costUsd\" value=\"0.01\"/>");
    expect(xml).toContain("<property name=\"unknownCostRuns\" value=\"1\"/>");
  });

  it("a failed case becomes a routing failure with the per-run body", () => {
    const failed = sample().match(/<failure message="[^"]*" type="routing">[\s\S]*?<\/failure>/);
    expect(failed).not.toBeNull();
    expect(failed?.[0]).toContain("<failure message=\"not loaded find-bug\" type=\"routing\">");
    expect(failed?.[0]).toContain("run 1: ok loaded [find-bug]");
    expect(failed?.[0]).toContain("run 2: FAIL loaded [] · not loaded find-bug");
    expect(failed?.[0]).toContain("diagnosis: skill named in text but not invoked");
    expect(failed?.[0]).toContain("note: watch for false positives");
  });

  it("an all-error case becomes an error element counting into errors", () => {
    const xml = sample();
    expect(xml).toContain("<error message=\"timeout after 180s\" type=\"run\">run 1: FAIL loaded [] · timeout after 180s</error>");
    expect(xml).toContain("<testcase name=\"#3 timeout case\" classname=\"skillcheck.claude\" time=\"1\">");
  });

  it("a skipped case gets the budget-reached skip element", () => {
    expect(sample()).toContain("<testcase name=\"#4 never started\" classname=\"skillcheck.claude\" time=\"0\">\n        <skipped message=\"budget reached\"/>\n      </testcase>");
  });

  it("omits the model property when there is no model", () => {
    const xml = makeReport([done(c1, [verdict(c1, { loaded: ["find-bug"] })])], null);
    expect(xml).not.toContain("name=\"model\"");
    expect(xml).toContain("name=\"agent\"");
  });

  it("escapes attribute-hostile characters and drops invalid XML 1.0 codepoints", () => {
    const nasty = kase({ index: 9, query: "a <b> & \"c\" 'd' " + "bell\x07bell" });
    const xml = makeReport([done(nasty, [verdict(nasty, { loaded: ["find-bug"] })])]);
    const name = xml.match(/<testcase name="([^"]*)"/)?.[1];
    expect(name).toBe("#9 a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; bellbell");
    expect(name).not.toContain("\x07");
  });

  it("is well-formed XML when xmllint is available", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "skillcheck-junit-")), "r.xml");
    writeFileSync(file, sample());
    const lint = spawnSync("xmllint", ["--noout", file], { encoding: "utf8" });
    if (lint.error && (lint.error as NodeJS.ErrnoException).code === "ENOENT") return; // not installed, skip
    expect(lint.status).toBe(0);
  });
});
