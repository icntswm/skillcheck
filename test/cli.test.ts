import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { AgentAdapter, BatchOptions, BatchResult, RunOptions, RunResult, SkillList } from "../src/agents/types.js";

const okRun: RunResult = {
  loaded: ["find-bug"], text: "", costUsd: 0.05, availableSkills: ["find-bug", "test-guard"],
  error: null, stoppedEarly: true, durationMs: 10,
};

/** adapter that answers each query from a fixed table, recording the options */
function fakeAdapter(byQuery: Record<string, Partial<RunResult>>, calls: RunOptions[] = []): AgentAdapter & { calls: RunOptions[] } {
  return {
    name: "claude",
    calls,
    async run(opts: RunOptions): Promise<RunResult> {
      calls.push(opts);
      return { ...okRun, loaded: [], text: "", ...byQuery[opts.query] };
    },
  };
}

class Sink extends Writable {
  private readonly chunks: string[] = [];
  readonly isTTY = false;

  override _write(chunk: string, _enc: string, cb: () => void): void {
    this.chunks.push(String(chunk));
    cb();
  }

  get text(): string {
    return this.chunks.join("");
  }
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "skillcheck-cli-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeCases(name: string, body: unknown): string {
  const file = path.join(tmp, name);
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return file;
}

const SUITE = {
  agent: "claude",
  cases: [
    { query: "why does it fail", expect: ["find-bug"] },
    { query: "flaky on retry", expect_any: ["test-guard"], id: "flaky-case" },
  ],
};

describe("cli check", () => {
  it("accepts a valid file without the name check", async () => {
    const file = writeCases("cases.json", SUITE);
    const out = new Sink();
    const code = await main(["check", file, "--no-name-check"], { stdout: out, stderr: out, cwd: tmp });
    expect(code).toBe(0);
    expect(out.text).toBe(`${file}: 2 cases, ok\n`);
  });

  it("reports validation errors with the file path and exits 2", async () => {
    const file = writeCases("cases.json", { cases: [{ query: "x", foo: 1 }] });
    const out = new Sink();
    const code = await main(["check", file], { stdout: out, stderr: out, cwd: tmp });
    expect(code).toBe(2);
    expect(out.text).toContain(`skillcheck: ${file}: `);
    expect(out.text).toContain('unknown key "foo"');
  });

  it("flags unknown skill names against the config dir", async () => {
    const cfg = path.join(tmp, "cfg");
    mkdirSync(path.join(cfg, "skills", "find-bug"), { recursive: true });
    writeFileSync(path.join(cfg, "skills", "find-bug", "SKILL.md"), "# find-bug\n");
    const file = writeCases("cases.json", { cases: [{ query: "q", expect: ["find-bug", "ghost"] }] });
    const out = new Sink();
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      const code = await main(["check", file], { stdout: out, stderr: out, cwd: tmp });
      expect(code).toBe(2);
      expect(out.text).toContain('#1: unknown skill "ghost" in expect');
      expect(out.text).not.toContain('"find-bug"');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe("cli run", () => {
  it("passes all cases, prints header, lines and summary, exits 0", async () => {
    const file = writeCases("cases.json", SUITE);
    const out = new Sink();
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] }, "flaky on retry": { loaded: ["test-guard"] } }, calls);
    const code = await main(["run", file], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(0);
    const lines = out.text.split("\n");
    expect(lines[0]).toBe("2 cases × 1 repeat × 1 agent = 2 runs");
    expect(out.text).toContain("ok    #1  why does it fail  → find-bug");
    expect(out.text).toContain("ok    #flaky-case  flaky on retry  → test-guard");
    expect(lines.at(-2)).toBe("0 failed of 2 · runs 2 · cost $0.10");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.directive).toContain("[SKILL ROUTING CHECK]");
    expect(calls[0]?.timeoutMs).toBe(180_000);
    expect(calls[0]?.earlyStop).toBe(true);
  });

  it("exits 1 on failures and prints the reason", async () => {
    const file = writeCases("cases.json", SUITE);
    const out = new Sink();
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["test-guard"] }, "flaky on retry": { loaded: ["test-guard"] } });
    const code = await main(["run", file], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(1);
    expect(out.text).toContain("FAIL  #1  why does it fail  → test-guard · not loaded find-bug");
    expect(out.text).toContain("1 failed of 2");
  });

  it("honours --only by index and by id", async () => {
    const file = writeCases("cases.json", SUITE);
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] }, "flaky on retry": { loaded: ["test-guard"] } }, calls);
    const out = new Sink();
    expect(await main(["run", file, "--only", "1"], { stdout: out, stderr: out, cwd: tmp }, { adapter })).toBe(0);
    expect(calls.map((c) => c.query)).toEqual(["why does it fail"]);

    const calls2: RunOptions[] = [];
    const adapter2 = fakeAdapter({ "flaky on retry": { loaded: ["test-guard"] } }, calls2);
    const out2 = new Sink();
    expect(await main(["run", file, "--only", "flaky-case"], { stdout: out2, stderr: out2, cwd: tmp }, { adapter: adapter2 })).toBe(0);
    expect(calls2.map((c) => c.query)).toEqual(["flaky on retry"]);
  });

  it("exits 2 when --only matches nothing", async () => {
    const file = writeCases("cases.json", SUITE);
    const out = new Sink();
    const code = await main(["run", file, "--only", "99"], { stdout: out, stderr: out, cwd: tmp }, { adapter: fakeAdapter({}) });
    expect(code).toBe(2);
    expect(out.text).toContain("--only 99 matches nothing");
  });

  it("repeats cases and applies the threshold", async () => {
    const file = writeCases("cases.json", {
      cases: [{ query: "why does it fail", expect: ["find-bug"], repeat: 3, threshold: 0.6 }],
    });
    const out = new Sink();
    let n = 0;
    const adapter: AgentAdapter = {
      name: "claude",
      async run(): Promise<RunResult> {
        n++;
        return { ...okRun, loaded: n === 2 ? [] : ["find-bug"] };
      },
    };
    const code = await main(["run", file], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(0);
    expect(out.text).toContain("1 cases × 1 repeat × 1 agent = 3 runs");
    expect(out.text).toContain("2/3");
  });

  it("rejects an unknown agent", async () => {
    const file = writeCases("cases.json", SUITE);
    const out = new Sink();
    const code = await main(["run", file, "--agent", "codex"], { stdout: out, stderr: out, cwd: tmp }, { adapter: fakeAdapter({}) });
    expect(code).toBe(2);
    expect(out.text).toContain('unknown agent "codex"');
  });

  it("warns about expected skills missing from the agent inventory", async () => {
    const file = writeCases("cases.json", { cases: [{ query: "why does it fail", expect: ["find-bug"] }] });
    const out = new Sink();
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"], availableSkills: ["other-skill"] } });
    const code = await main(["run", file], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(0);
    expect(out.text).toContain("warning: expected skills not available to the agent: find-bug");
  });

  it("reads the directive from a file and passes --model through", async () => {
    const file = writeCases("cases.json", SUITE);
    const directive = path.join(tmp, "dir.txt");
    writeFileSync(directive, "custom directive\n");
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] }, "flaky on retry": { loaded: ["test-guard"] } }, calls);
    const out = new Sink();
    const code = await main(["run", file, "--directive", directive, "--model", "sonnet", "--timeout", "5", "--no-early-stop"],
      { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(0);
    expect(calls[0]?.directive).toBe("custom directive");
    expect(calls[0]?.model).toBe("sonnet");
    expect(calls[0]?.timeoutMs).toBe(5_000);
    expect(calls[0]?.earlyStop).toBe(false);
  });

  it("exits 2 on a broken cases file or a bad flag", async () => {
    const bad = writeCases("bad.json", "{ not json");
    const out = new Sink();
    expect(await main(["check", bad], { stdout: out, stderr: out, cwd: tmp })).toBe(2);
    expect(out.text).toContain("cannot parse");

    const out2 = new Sink();
    expect(await main(["run", writeCases("cases.json", SUITE), "--jobs", "x"], { stdout: out2, stderr: out2, cwd: tmp }, { adapter: fakeAdapter({}) })).toBe(2);
    expect(out2.text).toContain("--jobs must be an integer");
  });

  it("prints usage for --help and exits 2 with no command", async () => {
    const out = new Sink();
    expect(await main(["--help"], { stdout: out, stderr: out, cwd: tmp })).toBe(0);
    expect(out.text).toContain("Usage:");
    expect(out.text).toContain("--batch ");
    expect(out.text).toContain("--batch-size <n>");
    expect(out.text).toContain("--skill <a,b>");
    expect(out.text).toContain("(default: 0.3)");
    expect(out.text).toContain("--budget <usd>");
    expect(out.text).toContain("--json <path>");
    expect(out.text).toContain("--junit <path>");
    expect(out.text).toContain("--markdown <path>");
    expect(out.text).toContain("skillcheck list");
    expect(out.text).toContain("skillcheck init");
    expect(out.text).toContain("--config-dir <dir>");
    expect(out.text).toContain("--force");
    const out2 = new Sink();
    expect(await main([], { stdout: out2, stderr: out2, cwd: tmp })).toBe(2);
    expect(out2.text).toContain("Usage:");
  });

  it("prints the package version", async () => {
    const out = new Sink();
    expect(await main(["--version"], { stdout: out, stderr: out, cwd: tmp })).toBe(0);
    expect(out.text.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("finds skillcheck.yaml in the working directory", async () => {
    writeFileSync(path.join(tmp, "skillcheck.yaml"), "cases:\n  - query: why does it fail\n    expect: [find-bug]\n");
    const out = new Sink();
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] } });
    expect(await main(["run"], { stdout: out, stderr: out, cwd: tmp }, { adapter })).toBe(0);
    expect(out.text).toContain("ok    #1");
  });

  it("filters cases by the agents field", async () => {
    const file = writeCases("cases.json", {
      cases: [
        { query: "why does it fail", expect: ["find-bug"] },
        { query: "other agent", expect: ["find-bug"], agents: ["codex"] },
      ],
    });
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] } }, calls);
    const out = new Sink();
    expect(await main(["run", file], { stdout: out, stderr: out, cwd: tmp }, { adapter })).toBe(0);
    expect(calls.map((c) => c.query)).toEqual(["why does it fail"]);
    expect(out.text).toContain("1 cases × 1 repeat × 1 agent = 1 runs");
  });
});

describe("cli run: fatal errors", () => {
  it("Not logged in stops starting new runs and exits 2", async () => {
    const file = writeCases("cases.json", { cases: [
      { query: "q1", expect: ["find-bug"] }, { query: "q2", expect: ["find-bug"] }, { query: "q3", expect: ["find-bug"] },
    ] });
    const out = new Sink();
    const err = new Sink();
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ q1: { error: "claude error: Not logged in · Please run /login" } }, calls);
    const code = await main(["run", file, "--jobs", "1"], { stdout: out, stderr: err, cwd: tmp }, { adapter });
    expect(code).toBe(2);
    expect(calls).toHaveLength(1);
    expect(err.text).toContain("Not logged in");
  });

  it("an ordinary run error does not stop the others", async () => {
    const file = writeCases("cases.json", { cases: [
      { query: "q1", expect: ["find-bug"] }, { query: "q2", expect: ["find-bug"] },
    ] });
    const out = new Sink();
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ q1: { error: "timeout after 180s" }, q2: { loaded: ["find-bug"] } }, calls);
    const code = await main(["run", file, "--jobs", "1"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
  });
});

describe("cli run --batch", () => {
  /** answers every numbered request in the prompt from the query table */
  function batchAdapter(byQuery: Record<string, string[]>, calls: BatchOptions[] = [], over: Partial<BatchResult> = {}): AgentAdapter & { calls: BatchOptions[] } {
    return {
      name: "claude",
      calls,
      async run(): Promise<RunResult> {
        throw new Error("plain run must not be used in batch mode");
      },
      async runBatch(opts: BatchOptions): Promise<BatchResult> {
        calls.push(opts);
        const answers: { n: number; skills: string[] }[] = [];
        for (const m of opts.prompt.matchAll(/^(\d+)\. "((?:[^"\\]|\\.)*)"$/gm)) {
          const query = JSON.parse(`"${m[2]}"`) as string;
          answers.push({ n: Number(m[1]), skills: byQuery[query] ?? [] });
        }
        return { structured: { answers }, text: "", costUsd: 0.1, error: null, durationMs: 5, ...over };
      },
    };
  }

  function suiteN(n: number): unknown {
    return {
      agent: "claude",
      cases: Array.from({ length: n }, (_, i) => ({ query: `q${i + 1}`, expect: ["find-bug"] })),
    };
  }
  const allQ = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`q${i + 1}`, ["find-bug"]]));

  it("splits cases into chunks: 5 cases at size 2 is 3 calls", async () => {
    const file = writeCases("cases.json", suiteN(5));
    const out = new Sink();
    const calls: BatchOptions[] = [];
    const adapter = batchAdapter(allQ, calls, { costUsd: 0.06 });
    const code = await main(["run", file, "--batch", "--batch-size", "2"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
    const lines = out.text.split("\n");
    expect(lines[0]).toBe("5 cases × 1 repeat, batch mode = 3 calls");
    // 0.06 per call: 4 cases in pairs pay 0.03 each, the single case pays 0.06
    expect(out.text).toContain("0 failed of 5 · runs 5 · cost $0.18");
    // each prompt holds its chunk's requests, numbered from 1
    expect(calls[2]?.prompt).toContain('1. "q5"');
    expect(calls[0]?.prompt).toContain('2. "q2"');
    expect(calls[0]?.prompt).not.toContain('"q3"');
  });

  it("prints the batch footer and omits --only when nothing failed", async () => {
    const file = writeCases("cases.json", suiteN(2));
    const out = new Sink();
    await main(["run", file, "--batch"], { stdout: out, stderr: out, cwd: tmp }, { adapter: batchAdapter(allQ) });
    expect(out.text).toContain(
      "batch mode: answers are the model's stated choice, not an actual Skill call — confirm failures with a normal run\n",
    );
    expect(out.text).not.toContain("--only");
  });

  it("failed ids go into the footer hint", async () => {
    const file = writeCases("cases.json", { cases: [
      { query: "q1", expect: ["find-bug"], id: "one" },
      { query: "q2", expect: ["ghost"] },
    ] });
    const out = new Sink();
    const code = await main(["run", file, "--batch"], { stdout: out, stderr: out, cwd: tmp }, { adapter: batchAdapter({ q1: ["find-bug"], q2: ["find-bug"] }) });
    expect(code).toBe(1);
    expect(out.text).toContain("normal run (--only 2)");
  });

  it("cases that only errored stay out of the footer hint", async () => {
    const file = writeCases("cases.json", suiteN(2));
    const out = new Sink();
    const adapter = batchAdapter(allQ, [], { structured: null, error: "timeout after 180s" });
    const code = await main(["run", file, "--batch"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(1);
    expect(out.text).toContain("confirm failures with a normal run\n");
    expect(out.text).not.toContain("--only");
  });

  it("an auth error stops the run with exit 2 and no summary", async () => {
    const file = writeCases("cases.json", suiteN(5));
    const out = new Sink();
    const err = new Sink();
    const calls: BatchOptions[] = [];
    const adapter = batchAdapter(allQ, calls, { structured: null, error: "claude error: Failed to authenticate. API Error: 401 OAuth access token is invalid." });
    const code = await main(["run", file, "--batch", "--batch-size", "1", "--jobs", "1"], { stdout: out, stderr: err, cwd: tmp }, { adapter });
    expect(code).toBe(2);
    expect(calls).toHaveLength(1);
    expect(err.text).toContain("skillcheck: stopped, the agent cannot run: claude error: Failed to authenticate.");
    expect(out.text).not.toContain("failed of");
  });

  it("a case with no answer in the chunk fails with the no-answer error", async () => {
    const file = writeCases("cases.json", { cases: [{ query: "q1", expect: ["find-bug"] }, { query: "q2", expect: ["find-bug"] }] });
    const out = new Sink();
    const adapter: AgentAdapter = {
      name: "claude",
      async run(): Promise<RunResult> { throw new Error("unused"); },
      async runBatch(): Promise<BatchResult> {
        return { structured: { answers: [{ n: 1, skills: ["find-bug"] }] }, text: "", costUsd: 0.02, error: null, durationMs: 1 };
      },
    };
    const code = await main(["run", file, "--batch"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(1);
    expect(out.text).toContain("no answer for this case in the batch");
  });

  it("a chunk error becomes the error of every case in it", async () => {
    const file = writeCases("cases.json", suiteN(2));
    const out = new Sink();
    const code = await main(["run", file, "--batch"], { stdout: out, stderr: out, cwd: tmp },
      { adapter: batchAdapter(allQ, [], { structured: null, error: "timeout after 180s" }) });
    expect(code).toBe(1);
    expect(out.text.match(/timeout after 180s/g)).toHaveLength(2);
  });

  it("splits the chunk cost over its cases", async () => {
    const file = writeCases("cases.json", suiteN(4));
    const out = new Sink();
    // 0.04 per call, two calls of two cases -> 4 × 0.02 = 0.08
    const adapter = batchAdapter(allQ, [], { costUsd: 0.04 });
    await main(["run", file, "--batch", "--batch-size", "2"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(out.text).toContain("cost $0.08");
  });

  it("repeats the whole set of chunks per round", async () => {
    const file = writeCases("cases.json", suiteN(2));
    const calls: BatchOptions[] = [];
    const out = new Sink();
    const code = await main(["run", file, "--batch", "--repeat", "2"], { stdout: out, stderr: out, cwd: tmp }, { adapter: batchAdapter(allQ, calls) });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(out.text).toContain("2 cases × 2 repeat, batch mode = 2 calls");
  });

  it("a case with a smaller repeat only takes its first rounds", async () => {
    const file = writeCases("cases.json", { cases: [
      { query: "q1", expect: ["find-bug"], repeat: 3 },
      { query: "q2", expect: ["find-bug"] },
    ] });
    const calls: BatchOptions[] = [];
    const out = new Sink();
    const code = await main(["run", file, "--batch"], { stdout: out, stderr: out, cwd: tmp }, { adapter: batchAdapter(allQ, calls) });
    expect(code).toBe(0);
    expect(calls).toHaveLength(3); // rounds = max repeat
    expect(calls[1]?.prompt).toContain('"q1"');
    expect(calls[1]?.prompt).not.toContain('"q2"'); // q2 was done after round 1
    expect(out.text).toContain("2 cases × 1 repeat, batch mode = 3 calls");
  });

  it("the named-but-not-invoked diagnosis must not fire (text is empty)", async () => {
    const file = writeCases("cases.json", { cases: [{ query: "q1", expect: ["find-bug"] }] });
    const out = new Sink();
    await main(["run", file, "--batch"], { stdout: out, stderr: out, cwd: tmp }, { adapter: batchAdapter({ q1: [] }) });
    expect(out.text).toContain("FAIL");
    expect(out.text).not.toContain("diagnosis");
  });

  it("rejects batch-only flag combinations with exit 2", async () => {
    const file = writeCases("cases.json", suiteN(2));
    const run = async (args: string[], adapter?: AgentAdapter): Promise<[number, string]> => {
      const out = new Sink();
      const code = await main(["run", file, ...args], { stdout: out, stderr: out, cwd: tmp }, { adapter: adapter ?? batchAdapter(allQ) });
      return [code, out.text];
    };
    const [c1, t1] = await run(["--batch-size", "2"]);
    expect([c1, t1]).toEqual([2, expect.stringContaining("--batch-size requires --batch")]);
    const [c2, t2] = await run(["--batch", "--directive", file]);
    expect([c2, t2]).toEqual([2, expect.stringContaining("do not apply to --batch")]);
    const [c3, t3] = await run(["--batch", "--no-early-stop"]);
    expect([c3, t3]).toEqual([2, expect.stringContaining("do not apply to --batch")]);
    const [c4, t4] = await run(["--batch", "--batch-size", "0"]);
    expect([c4, t4]).toEqual([2, expect.stringContaining("--batch-size must be an integer >= 1")]);
    const [c5, t5] = await run(["--batch"], fakeAdapter({}));
    expect([c5, t5]).toEqual([2, expect.stringContaining("agent claude has no batch mode")]);
  });
});

describe("cli --skill", () => {
  it("run keeps only cases mentioning the named skills", async () => {
    const file = writeCases("cases.json", SUITE);
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "flaky on retry": { loaded: ["test-guard"] } }, calls);
    const out = new Sink();
    const code = await main(["run", file, "--skill", "test-guard"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(0);
    expect(calls.map((c) => c.query)).toEqual(["flaky on retry"]);
  });

  it("matches forbid and first too", async () => {
    const file = writeCases("cases.json", { cases: [
      { query: "forbid me", forbid: ["find-bug"] },
      { query: "first me", first: "test-guard" },
      { query: "unrelated", expect: ["other-skill"] },
    ] });
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "forbid me": {}, "first me": { loaded: ["test-guard"] } }, calls);
    const out = new Sink();
    const code = await main(["run", file, "--skill", "find-bug,test-guard"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(0);
    expect(calls.map((c) => c.query)).toEqual(["forbid me", "first me"]);
  });

  it("intersects with --only and errors on an empty intersection", async () => {
    const file = writeCases("cases.json", SUITE);
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] } }, calls);
    const out = new Sink();
    expect(await main(["run", file, "--only", "1", "--skill", "find-bug"], { stdout: out, stderr: out, cwd: tmp }, { adapter })).toBe(0);
    expect(calls.map((c) => c.query)).toEqual(["why does it fail"]);

    const out2 = new Sink();
    const code = await main(["run", file, "--only", "flaky-case", "--skill", "find-bug"], { stdout: out2, stderr: out2, cwd: tmp }, { adapter: fakeAdapter({}) });
    expect(code).toBe(2);
    expect(out2.text).toContain("no cases match --skill find-bug");
  });

  it("exits 2 when nothing matches at all", async () => {
    const file = writeCases("cases.json", SUITE);
    const out = new Sink();
    const code = await main(["run", file, "--skill", "ghost"], { stdout: out, stderr: out, cwd: tmp }, { adapter: fakeAdapter({}) });
    expect(code).toBe(2);
    expect(out.text).toContain("no cases match --skill ghost");
  });

  it("check filters too and reports the filtered count", async () => {
    const file = writeCases("cases.json", SUITE);
    const out = new Sink();
    const code = await main(["check", file, "--skill", "find-bug", "--no-name-check"], { stdout: out, stderr: out, cwd: tmp });
    expect(code).toBe(0);
    expect(out.text).toBe(`${file}: 1 cases, ok\n`);
    const out2 = new Sink();
    expect(await main(["check", file, "--skill", "ghost", "--no-name-check"], { stdout: out2, stderr: out2, cwd: tmp })).toBe(2);
    expect(out2.text).toContain("no cases match --skill ghost");
  });
});

describe("cli --budget", () => {
  it("stops starting new runs once the estimate reaches the limit", async () => {
    const file = writeCases("cases.json", {
      cases: Array.from({ length: 4 }, () => ({ query: "why does it fail", expect: ["find-bug"] })),
    });
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] } }, calls); // $0.05 a run
    const out = new Sink();
    const code = await main(["run", file, "-j", "1", "--budget", "0.15"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(1); // a skipped case also fails the run
    expect(calls).toHaveLength(3);
    const lines = out.text.split("\n");
    expect(lines[1]).toBe("ok    #1  why does it fail  → find-bug");
    const skipAt = lines.indexOf("skip  #4  why does it fail  → budget reached");
    expect(skipAt).toBeGreaterThan(lines.indexOf("ok    #3  why does it fail  → find-bug")); // printed after all runs settle
    expect(out.text).toContain("budget $0.15 reached (spent ~$0.15), 1 runs not started");
    expect(out.text).toContain("0 failed, 1 skipped of 4 · runs 3 · cost $0.15");
  });

  it("trips on early-stopped runs that report tokens but no cost", async () => {
    const file = writeCases("cases.json", {
      cases: Array.from({ length: 4 }, () => ({ query: "why does it fail", expect: ["find-bug"] })),
    });
    const calls: RunOptions[] = [];
    const usage = { model: "claude-sonnet-5", input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 25_000 };
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"], costUsd: null, usage } }, calls); // ~$0.15 a run at list price
    const out = new Sink();
    const code = await main(["run", file, "-j", "1", "--budget", "0.3"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
    expect(out.text).toContain("budget $0.30 reached (spent ~$0.30), 2 runs not started");
    expect(out.text).toContain("runs 2 · cost ~$0.30 (2 runs estimated from tokens)");
  });

  it("a case whose runs did not all start is skipped whole, not aggregated", async () => {
    const file = writeCases("cases.json", { cases: [
      { query: "why does it fail", expect: ["find-bug"], repeat: 3 },
      { query: "also fails", expect: ["find-bug"] },
    ] });
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] }, "also fails": { loaded: ["find-bug"] } }, calls);
    const out = new Sink();
    const code = await main(["run", file, "-j", "1", "--budget", "0.1"], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(1);
    expect(calls).toHaveLength(2); // 2 × $0.05 fills the budget
    expect(out.text).toContain("skip  #1  why does it fail  → budget reached");
    expect(out.text).toContain("skip  #2  also fails  → budget reached");
    expect(out.text).not.toContain("ok    #1");
    expect(out.text).toContain("0 failed, 2 skipped of 2 · runs 0 · cost ?");
    expect(out.text).toContain("budget $0.10 reached (spent ~$0.10), 2 runs not started");
  });

  it("rejects a non-numeric or non-positive budget with exit 2", async () => {
    const file = writeCases("cases.json", SUITE);
    for (const bad of ["0", "-1", "abc"]) {
      const out = new Sink();
      const code = await main(["run", file, `--budget=${bad}`], { stdout: out, stderr: out, cwd: tmp }, { adapter: fakeAdapter({}) });
      expect(code).toBe(2);
      expect(out.text).toContain("--budget must be a number > 0");
    }
  });
});

describe("cli --json and --junit", () => {
  it("--json - prints pure JSON on stdout and the human report on stderr", async () => {
    const file = writeCases("cases.json", SUITE);
    const stdout = new Sink();
    const stderr = new Sink();
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] }, "flaky on retry": { loaded: ["test-guard"] } });
    const code = await main(["run", file, "--json", "-"], { stdout, stderr, cwd: tmp }, { adapter });
    expect(code).toBe(0);
    const report = JSON.parse(stdout.text);
    expect(report).toMatchObject({
      tool: "skillcheck",
      file,
      agent: "claude",
      model: null,
      summary: { cases: 2, failed: 0, skipped: 0, runs: 2, costUsd: 0.1, estimatedCostUsd: 0.1, budgetUsd: null, budgetReached: false },
    });
    expect(report.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.cases.map((c: { status: string }) => c.status)).toEqual(["passed", "passed"]);
    expect(stderr.text).toContain("ok    #1");
  });

  it("writes --json, --junit and --markdown files and the confusion block", async () => {
    const file = writeCases("cases.json", SUITE);
    const jsonPath = path.join(tmp, "report.json");
    const xmlPath = path.join(tmp, "report.xml");
    const mdPath = path.join(tmp, "report.md");
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["test-guard"] }, "flaky on retry": { loaded: ["test-guard"] } });
    const out = new Sink();
    const code = await main(["run", file, "--json", jsonPath, "--junit", xmlPath, "--markdown", mdPath], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(1);
    const report = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(report.summary.failed).toBe(1);
    expect(report.batch).toBe(false);
    expect(report.cases[1].id).toBe("flaky-case");
    expect(report.confusion).toEqual([{ expected: "find-bug", got: "test-guard", count: 1 }]);
    const xml = readFileSync(xmlPath, "utf8");
    expect(xml).toContain('<testsuites name="skillcheck" tests="2" failures="1" errors="0"');
    expect(xml).toContain('<failure message="not loaded find-bug" type="routing">');
    const md = readFileSync(mdPath, "utf8");
    expect(md.startsWith("<!-- skillcheck -->\n")).toBe(true);
    expect(md).toContain("❌");
    expect(out.text).toContain("confusion:");
    expect(out.text).toContain("  expected find-bug → got test-guard (1)");
  });

  it("exits 2 when a report file cannot be written", async () => {
    const file = writeCases("cases.json", SUITE);
    const target = path.join(tmp, "no-such-dir", "r.json");
    const out = new Sink();
    const code = await main(["run", file, "--json", target], { stdout: out, stderr: out, cwd: tmp }, { adapter: fakeAdapter({}) });
    expect(code).toBe(2);
    expect(out.text).toContain(`cannot write --json ${target}`);
  });
});

describe("cli lint", () => {
  let cfg: string;
  let prevCfgDir: string | undefined;

  // two skills with near-identical, long descriptions and one short one
  function seedSkills(): void {
    cfg = mkdtempSync(path.join(tmp, "lint-cfg-"));
    prevCfgDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const skills = {
      "find-bug": "diagnose why a program crashes with a long stack trace and find the failing line of code",
      "test-guard": "diagnose why a program crashes with a long stack trace and find the failing line of code",
      tiny: "short text",
    };
    for (const [name, description] of Object.entries(skills)) {
      const dir = path.join(cfg, "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), `---\ndescription: ${description}\n---\nbody\n`);
    }
  }

  function restoreCfg(): void {
    if (prevCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfgDir;
  }

  it("prints every populated section with counts", async () => {
    seedSkills();
    try {
      const file = writeCases("cases.json", {
        cases: [{ query: "diagnose a crash stack trace", expect: ["tiny"], id: "far-case" }],
      });
      const out = new Sink();
      const code = await main(["lint", file, "--top", "2", "--overlap", "0.5"], { stdout: out, stderr: out, cwd: tmp });
      expect(code).toBe(0);
      expect(out.text).toContain("lint: 3 skills and commands with descriptions, 1 cases");
      expect(out.text).toContain("short descriptions (1):");
      expect(out.text).toContain("  tiny  skill, 10 chars");
      expect(out.text).toContain("similar descriptions (1):");
      expect(out.text).toMatch(/find-bug ↔ test-guard  0\.\d\d/);
      expect(out.text).toContain("expected skill far from the query (1):");
      expect(out.text).toContain("  #far-case  diagnose a crash stack trace  → tiny ranked 3 (top: test-guard, find-bug, tiny)");
      expect(out.text).toContain("uncovered skills (2 of 3):");
      expect(out.text).toContain("  find-bug, test-guard");
      expect(out.text).not.toContain("no problems found");
    } finally {
      restoreCfg();
    }
  });

  it("prints no problems found when nothing is flagged", async () => {
    cfg = mkdtempSync(path.join(tmp, "lint-clean-"));
    prevCfgDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      const dir = path.join(cfg, "skills", "zeta");
      mkdirSync(dir, { recursive: true });
      const desc = "quantum entanglement of photons measured in a very long physics laboratory description";
      writeFileSync(path.join(dir, "SKILL.md"), `---\ndescription: ${desc}\n---\n`);
      const file = writeCases("cases.json", { cases: [{ query: desc, expect: ["zeta"] }] });
      const out = new Sink();
      expect(await main(["lint", file], { stdout: out, stderr: out, cwd: tmp })).toBe(0);
      expect(out.text).toContain("no problems found");
    } finally {
      restoreCfg();
    }
  });

  it("exits 1 under --strict when there is a problem, 0 otherwise", async () => {
    seedSkills();
    try {
      const file = writeCases("cases.json", { cases: [{ query: "why does it crash", expect: ["find-bug"] }] });
      const soft = new Sink();
      expect(await main(["lint", file], { stdout: soft, stderr: soft, cwd: tmp })).toBe(0);
      const strict = new Sink();
      expect(await main(["lint", file, "--strict"], { stdout: strict, stderr: strict, cwd: tmp })).toBe(1);
    } finally {
      restoreCfg();
    }
  });

  it("runs without a cases file and says so", async () => {
    seedSkills();
    try {
      const out = new Sink();
      expect(await main(["lint"], { stdout: out, stderr: out, cwd: tmp })).toBe(0);
      expect(out.text).toContain("no cases file");
    } finally {
      restoreCfg();
    }
  });

  it("rejects bad --top and --overlap with exit 2", async () => {
    seedSkills();
    try {
      const file = writeCases("cases.json", { cases: [{ query: "q", expect: ["find-bug"] }] });
      const out = new Sink();
      expect(await main(["lint", file, "--top", "0"], { stdout: out, stderr: out, cwd: tmp })).toBe(2);
      expect(out.text).toContain("--top must be an integer");
      const out2 = new Sink();
      expect(await main(["lint", file, "--overlap", "1.5"], { stdout: out2, stderr: out2, cwd: tmp })).toBe(2);
      expect(out2.text).toContain("--overlap must be a number");
    } finally {
      restoreCfg();
    }
  });

  it("exits 2 when an explicit cases file is broken", async () => {
    seedSkills();
    try {
      const file = writeCases("bad.json", "{ not json");
      const out = new Sink();
      expect(await main(["lint", file], { stdout: out, stderr: out, cwd: tmp })).toBe(2);
      expect(out.text).toContain("cannot parse");
    } finally {
      restoreCfg();
    }
  });

  it("wraps uncovered names so every line but the last ends with a comma", async () => {
    const many = mkdtempSync(path.join(tmp, "lint-many-"));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = many;
    try {
      for (let i = 1; i <= 20; i++) {
        const dir = path.join(many, "skills", `uncovered-skill-${String(i).padStart(2, "0")}`);
        mkdirSync(dir, { recursive: true });
        const filler = "zebra quantum lattice kernel matrix solar harbor cipher garden meadow canyon";
        writeFileSync(path.join(dir, "SKILL.md"), `---\ndescription: topic ${i} ${filler} ${"u".repeat(i)}\n---\n`);
      }
      const dir = path.join(many, "skills", "covered-one");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), "---\ndescription: covered skill description with plenty of unique words here\n---\n");
      const file = writeCases("cases.json", { cases: [{ query: "covered topic", expect: ["covered-one"] }] });
      const out = new Sink();
      expect(await main(["lint", file, "--top", "100"], { stdout: out, stderr: out, cwd: tmp })).toBe(0);
      const lines = out.text.split("\n");
      const header = lines.findIndex((l) => l.startsWith("uncovered skills (20 of 21):"));
      expect(header).toBeGreaterThan(-1);
      const body = lines.slice(header + 1).filter((l) => l.startsWith("  "));
      expect(body.length).toBeGreaterThan(1); // actually wrapped
      body.slice(0, -1).forEach((l) => expect(l.endsWith(",")).toBe(true));
      expect(body.at(-1)?.endsWith(",")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe("cli --config-dir", () => {
  it("exits 2 when the directory does not exist", async () => {
    const file = writeCases("cases.json", SUITE);
    const out = new Sink();
    const code = await main(["check", file, "--config-dir", path.join(tmp, "nope")], { stdout: out, stderr: out, cwd: tmp });
    expect(code).toBe(2);
    expect(out.text).toContain("--config-dir is not a directory");
  });

  it("passes the resolved absolute dir to the adapter as configDir", async () => {
    const cfg = path.join(tmp, "cfg");
    mkdirSync(cfg, { recursive: true });
    const file = writeCases("cases.json", SUITE);
    const calls: RunOptions[] = [];
    const adapter = fakeAdapter({ "why does it fail": { loaded: ["find-bug"] }, "flaky on retry": { loaded: ["test-guard"] } }, calls);
    const out = new Sink();
    const rel = path.relative(tmp, cfg); // resolved against io.cwd
    expect(await main(["run", file, "--config-dir", rel], { stdout: out, stderr: out, cwd: tmp }, { adapter })).toBe(0);
    expect(calls[0]?.configDir).toBe(cfg);
  });
});

describe("cli list", () => {
  function listAdapter(list: SkillList | null, seen: object[] = []): AgentAdapter {
    return {
      name: "claude",
      async run(): Promise<RunResult> {
        throw new Error("unused");
      },
      ...(list ? {
        listSkills: async (opts: { configDir?: string; timeoutMs: number }): Promise<SkillList> => {
          seen.push(opts);
          return list;
        },
      } : {}),
    };
  }

  it("prints both groups with counts and exits 0", async () => {
    const out = new Sink();
    const seen: { configDir?: string; timeoutMs: number }[] = [];
    const code = await main(["list", "--config-dir", tmp], { stdout: out, stderr: out, cwd: tmp },
      { adapter: listAdapter({ skills: ["b", "a"], slashCommands: ["x"], error: null }, seen) });
    expect(code).toBe(0);
    expect(out.text).toBe("skills (2):\n  b\n  a\nother slash commands (1):\n  x\n");
    expect(seen).toEqual([{ configDir: tmp, timeoutMs: 180_000 }]);
  });

  it("exits 2 when the agent reports an error", async () => {
    const out = new Sink();
    const code = await main(["list"], { stdout: out, stderr: out, cwd: tmp },
      { adapter: listAdapter({ skills: [], slashCommands: [], error: "claude not found" }) });
    expect(code).toBe(2);
    expect(out.text).toBe("skillcheck: claude not found\n");
  });

  it("exits 2 when the adapter has no list mode", async () => {
    const out = new Sink();
    const code = await main(["list"], { stdout: out, stderr: out, cwd: tmp }, { adapter: listAdapter(null) });
    expect(code).toBe(2);
    expect(out.text).toContain("has no list mode");
  });
});

describe("cli init", () => {
  function initAdapter(list: SkillList | null): AgentAdapter {
    return {
      name: "claude",
      async run(): Promise<RunResult> {
        throw new Error("unused");
      },
      ...(list ? { listSkills: async (): Promise<SkillList> => list } : {}),
    };
  }

  it("writes a starter file, lists skills, and the checker accepts it", async () => {
    const file = path.join(tmp, "skillcheck.yaml");
    const out = new Sink();
    const adapter = initAdapter({ skills: ["my-alpha", "code-review"], slashCommands: ["commit"], error: null });
    const code = await main(["init", file], { stdout: out, stderr: out, cwd: tmp }, { adapter });
    expect(code).toBe(0);
    expect(out.text).toBe(`wrote ${file} (2 skills listed)\n`);
    const text = readFileSync(file, "utf8");
    // alpha = first non-builtin skill: my-alpha, not code-review
    expect(text).toContain('query: "replace with a request that should load my-alpha"');
    expect(text).toContain("expect: [my-alpha]");
    expect(text).toContain("# Skills available to claude:");
    expect(text).toContain("#   my-alpha, code-review"); // names are written as the agent returned them
    expect(text).toContain("# Other slash commands:");
    expect(text).toContain("#   commit");
    expect(text).toContain("# model: sonnet");
    expect(text).not.toMatch(/^model:/m); // active model line must stay commented out

    // the generated file parses as a suite
    const out2 = new Sink();
    expect(await main(["check", file, "--no-name-check"], { stdout: out2, stderr: out2, cwd: tmp })).toBe(0);
  });

  it("uses my-skill and omits the slash block when there is nothing custom", async () => {
    const file = path.join(tmp, "empty.yaml");
    const out = new Sink();
    const code = await main(["init", file], { stdout: out, stderr: out, cwd: tmp },
      { adapter: initAdapter({ skills: ["code-review"], slashCommands: [], error: null }) });
    expect(code).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("expect: [my-skill]");
    expect(text).not.toContain("Other slash commands");
  });

  it("refuses to overwrite without --force, writes with it", async () => {
    const file = writeCases("keep.yaml", "agent: claude\ncases:\n  - query: old\n    none: true\n");
    const out = new Sink();
    const code = await main(["init", file], { stdout: out, stderr: out, cwd: tmp },
      { adapter: initAdapter({ skills: [], slashCommands: [], error: null }) });
    expect(code).toBe(2);
    expect(out.text).toBe(`skillcheck: ${file} exists, use --force to overwrite\n`);

    const out2 = new Sink();
    expect(await main(["init", file, "--force"], { stdout: out2, stderr: out2, cwd: tmp },
      { adapter: initAdapter({ skills: [], slashCommands: [], error: null }) })).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("# skillcheck cases");
  });

  it("falls back to the disk scan when the adapter has no list mode", async () => {
    const cfg = path.join(tmp, "cfg");
    mkdirSync(path.join(cfg, "skills", "disk-skill"), { recursive: true });
    writeFileSync(path.join(cfg, "skills", "disk-skill", "SKILL.md"), "# s\n");
    const file = path.join(tmp, "from-disk.yaml");
    const out = new Sink();
    const code = await main(["init", file, "--config-dir", cfg], { stdout: out, stderr: out, cwd: tmp }, { adapter: initAdapter(null) });
    expect(code).toBe(0);
    expect(out.text).toContain("note: could not ask the agent (agent claude has no list mode); listed skills found on disk");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("disk-skill");
    expect(text).toContain("expect: [disk-skill]"); // the only non-builtin name
  });

  it("falls back to the disk scan when listSkills errors", async () => {
    const cfg = path.join(tmp, "empty-cfg"); // keeps the scan independent of the real home
    mkdirSync(cfg, { recursive: true });
    const file = path.join(tmp, "err.yaml");
    const out = new Sink();
    const code = await main(["init", file, "--config-dir", cfg], { stdout: out, stderr: out, cwd: tmp },
      { adapter: initAdapter({ skills: [], slashCommands: [], error: "boom" }) });
    expect(code).toBe(0);
    expect(out.text).toContain("note: could not ask the agent (boom); listed skills found on disk");
    expect(readFileSync(file, "utf8")).toContain("expect: [my-skill]"); // built-ins only, nothing custom on disk
  });

  it("defaults the file to skillcheck.yaml in the working directory", async () => {
    const out = new Sink();
    const code = await main(["init"], { stdout: out, stderr: out, cwd: tmp },
      { adapter: initAdapter({ skills: [], slashCommands: [], error: null }) });
    expect(code).toBe(0);
    expect(out.text).toBe(`wrote ${path.join(tmp, "skillcheck.yaml")} (0 skills listed)\n`);
    expect(existsSync(path.join(tmp, "skillcheck.yaml"))).toBe(true);
  });
});
