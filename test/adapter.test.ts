import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { abortActiveRuns, ClaudeAdapter } from "../src/agents/claude.js";
import { BATCH_SCHEMA } from "../src/batch.js";
import type { RunOptions } from "../src/agents/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBin = path.join(here, "bin", "fake-claude.mjs");
const fixtures = path.join(here, "fixtures");

const ENV_KEYS = [
  "SKILLCHECK_CLAUDE_BIN", "FAKE_FIXTURE", "FAKE_HANG", "FAKE_IGNORE_TERM", "FAKE_EXIT",
  "FAKE_STDERR", "FAKE_ARGS_OUT", "CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR",
];

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return {
    query: "why does TestOrderCreate fail?",
    directive: "[SKILL ROUTING CHECK] load a skill and stop",
    timeoutMs: 30_000,
    earlyStop: true,
    ...over,
  };
}

describe("ClaudeAdapter", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "skillcheck-test-"));
    process.env.SKILLCHECK_CLAUDE_BIN = fakeBin;
    process.env.CLAUDE_PROJECT_DIR = "/should/not/be/passed";
    delete process.env.CLAUDE_CONFIG_DIR; // tests set it explicitly when they care
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses a fixture stream and reports no error", async () => {
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-garbage.jsonl");
    const r = await new ClaudeAdapter().run(opts());
    expect(r.error).toBeNull();
    expect(r.loaded).toEqual(["test-guard"]);
    expect(r.text).toBe("test-guard it is");
    expect(r.costUsd).toBeCloseTo(0.02, 10);
    expect(r.availableSkills).toEqual(["test-guard", "find-bug"]);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stops early and kills the process group when the fake hangs", async () => {
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-two-skills.jsonl");
    process.env.FAKE_HANG = "1";
    const started = Date.now();
    const r = await new ClaudeAdapter().run(opts());
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.stoppedEarly).toBe(true);
    expect(r.loaded).toEqual(["a", "b"]);
    expect(r.error).toBeNull();
  });

  it("kills a hanging process after the result event without calling it an early stop", async () => {
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-garbage.jsonl");
    process.env.FAKE_HANG = "1";
    const started = Date.now();
    const r = await new ClaudeAdapter().run(opts());
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.stoppedEarly).toBe(false);
    expect(r.costUsd).toBeCloseTo(0.02, 10);
    expect(r.error).toBeNull();
  });

  it("abortActiveRuns kills live runs and removes their tmp dirs", async () => {
    const argsOut = path.join(tmp, "args.json");
    process.env.FAKE_ARGS_OUT = argsOut;
    process.env.FAKE_HANG = "1";
    const started = Date.now();
    const run = new ClaudeAdapter().run(opts({ earlyStop: false }));
    while (!existsSync(argsOut)) await new Promise((r) => setTimeout(r, 20));
    await abortActiveRuns();
    const r = await run;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.error).toMatch(/claude exited/);
    const { cwd } = JSON.parse(readFileSync(argsOut, "utf8")) as { cwd: string };
    expect(existsSync(cwd)).toBe(false);
  });

  it("abortActiveRuns falls back to SIGKILL when the process ignores SIGTERM", async () => {
    const argsOut = path.join(tmp, "args.json");
    process.env.FAKE_ARGS_OUT = argsOut;
    process.env.FAKE_HANG = "1";
    process.env.FAKE_IGNORE_TERM = "1";
    const run = new ClaudeAdapter().run(opts({ earlyStop: false }));
    while (!existsSync(argsOut)) await new Promise((r) => setTimeout(r, 20));
    await abortActiveRuns(200);
    const r = await run;
    expect(r.error).toMatch(/claude exited with code SIGKILL/);
  });

  it("does not stop early when earlyStop is false; times out instead", async () => {
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-two-skills.jsonl");
    process.env.FAKE_HANG = "1";
    const started = Date.now();
    const r = await new ClaudeAdapter().run(opts({ earlyStop: false, timeoutMs: 400 }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.stoppedEarly).toBe(false);
    expect(r.error).toBe("timeout after 0.4s");
    expect(r.loaded).toEqual(["a", "b"]);
  });

  it("reports empty stdout with the exit code and stderr", async () => {
    process.env.FAKE_EXIT = "3";
    process.env.FAKE_STDERR = "boom happened\n";
    const r = await new ClaudeAdapter().run(opts());
    expect(r.error).toBe("claude exited with code 3: boom happened");
    expect(r.loaded).toEqual([]);
    expect(r.costUsd).toBeNull();
  });

  it("reports an exit before the result event as an error even after stdout", async () => {
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-init.jsonl");
    process.env.FAKE_EXIT = "1";
    process.env.FAKE_STDERR = "crashed\n";
    const r = await new ClaudeAdapter().run(opts({ earlyStop: false }));
    expect(r.error).toBe("claude exited with code 1 before its result: crashed");
  });

  it("reports a missing binary", async () => {
    process.env.SKILLCHECK_CLAUDE_BIN = path.join(tmp, "no-such-claude");
    const r = await new ClaudeAdapter().run(opts());
    expect(r.error).toBe(`${path.join(tmp, "no-such-claude")} not found`);
  });

  it("passes a non-zero exit through as a normal run when stdout arrived", async () => {
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-repeat.jsonl");
    process.env.FAKE_EXIT = "1"; // error_max_turns: not a failure by itself
    const r = await new ClaudeAdapter().run(opts({ earlyStop: false }));
    expect(r.error).toBeNull();
    expect(r.loaded).toEqual(["a"]);
  });

  it("builds claude args, runs in a deleted tmp dir, hides CLAUDE_PROJECT_DIR", async () => {
    const argsOut = path.join(tmp, "args.json");
    process.env.FAKE_ARGS_OUT = argsOut;
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-repeat.jsonl");
    const adapter = new ClaudeAdapter();
    const r = await adapter.run(opts({ model: "sonnet" }));
    expect(r.error).toBeNull();

    const seen = JSON.parse(readFileSync(argsOut, "utf8")) as {
      args: string[];
      cwd: string;
      claudeProjectDir: string | null;
    };
    const promptIndex = seen.args.indexOf("-p");
    expect(promptIndex).toBe(0);
    expect(seen.args[1]).toBe(`${opts().query}\n\n${opts().directive}`);
    expect(seen.args).toContain("--output-format");
    expect(seen.args).toContain("stream-json");
    expect(seen.args).toContain("--allowedTools");
    expect(seen.args).toContain("mcp__*");
    const modelIndex = seen.args.indexOf("--model");
    expect(modelIndex).toBeGreaterThan(-1);
    expect(seen.args[modelIndex + 1]).toBe("sonnet");

    expect(path.basename(seen.cwd)).toMatch(/^skillcheck-/);
    expect(existsSync(seen.cwd)).toBe(false); // removed after the run
    expect(seen.claudeProjectDir).toBeNull();
  });

  it("omits --model when no model is set", async () => {
    const argsOut = path.join(tmp, "args.json");
    process.env.FAKE_ARGS_OUT = argsOut;
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-repeat.jsonl");
    await new ClaudeAdapter().run(opts());
    const seen = JSON.parse(readFileSync(argsOut, "utf8")) as { args: string[] };
    expect(seen.args).not.toContain("--model");
  });

  it("passes configDir to the child as CLAUDE_CONFIG_DIR, hides it otherwise", async () => {
    const argsOut = path.join(tmp, "args.json");
    process.env.FAKE_ARGS_OUT = argsOut;
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-repeat.jsonl");
    const cfgDir = path.join(tmp, "cfg");
    await new ClaudeAdapter().run(opts({ configDir: cfgDir }));
    const seen = JSON.parse(readFileSync(argsOut, "utf8")) as { claudeConfigDir: string | null };
    expect(seen.claudeConfigDir).toBe(cfgDir);

    process.env.CLAUDE_CONFIG_DIR = "/env/dir"; // must be replaced, not inherited
    await new ClaudeAdapter().run(opts());
    const seen2 = JSON.parse(readFileSync(argsOut, "utf8")) as { claudeConfigDir: string | null };
    expect(seen2.claudeConfigDir).toBe("/env/dir"); // no configDir => the inherited value stands
  });

  it("appends the token hint to a Not logged in error only under configDir", async () => {
    process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-not-logged-in.jsonl");
    const plain = await new ClaudeAdapter().run(opts({ configDir: undefined }));
    expect(plain.error).toBe("claude error: Not logged in · Please run /login");
    const withDir = await new ClaudeAdapter().run(opts({ configDir: tmp }));
    expect(withDir.error).toBe(
      "claude error: Not logged in · Please run /login — with --config-dir, auth comes from ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)",
    );
  });

  describe("listSkills", () => {
    it("stops right after init even when the fake hangs, and keeps the lists apart", async () => {
      process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-init.jsonl");
      process.env.FAKE_HANG = "1"; // without the init kill this would only end on timeout
      const started = Date.now();
      const r = await new ClaudeAdapter().listSkills({ timeoutMs: 30_000 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(r.error).toBeNull();
      // skills sorted; slash commands sorted minus anything already a skill
      expect(r.skills).toEqual(["a", "b", "dup", "zeta"]);
      expect(r.slashCommands).toEqual(["commit", "review"]);
    });

    it("errors when the process never sends init (empty stdout)", async () => {
      process.env.FAKE_EXIT = "3";
      process.env.FAKE_STDERR = "boom happened\n";
      const r = await new ClaudeAdapter().listSkills({ timeoutMs: 30_000 });
      expect(r.skills).toEqual([]);
      expect(r.slashCommands).toEqual([]);
      expect(r.error).toBe("claude exited with code 3: boom happened");
    });

    it("errors on timeout when claude is missing", async () => {
      process.env.SKILLCHECK_CLAUDE_BIN = path.join(tmp, "no-such-claude");
      const r = await new ClaudeAdapter().listSkills({ timeoutMs: 30_000 });
      expect(r.error).toBe(`${path.join(tmp, "no-such-claude")} not found`);
    });
  });

  describe("runBatch", () => {
    const batchOpts = { prompt: "survey prompt", schema: BATCH_SCHEMA, timeoutMs: 30_000 };

    it("passes the schema as --json-schema and keeps the Skill tool allowed", async () => {
      const argsOut = path.join(tmp, "args.json");
      process.env.FAKE_ARGS_OUT = argsOut;
      process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-batch.jsonl");
      const r = await new ClaudeAdapter().runBatch({ ...batchOpts, model: "sonnet" });
      expect(r.error).toBeNull();

      const seen = JSON.parse(readFileSync(argsOut, "utf8")) as { args: string[] };
      const i = seen.args.indexOf("--json-schema");
      expect(i).toBeGreaterThan(-1);
      expect(JSON.parse(seen.args[i + 1] as string)).toEqual(BATCH_SCHEMA);
      expect(seen.args[0]).toBe("-p");
      expect(seen.args[1]).toBe("survey prompt");
      expect(seen.args).toContain("stream-json");
      expect(seen.args[seen.args.indexOf("--max-turns") + 1]).toBe("3");
      // Skill must stay out of --disallowedTools: the model still needs its skill list
      expect(seen.args).not.toContain("--allowedTools");
      expect(seen.args).not.toContain("Skill");
      expect(seen.args[seen.args.indexOf("--model") + 1]).toBe("sonnet");
    });

    it("returns the structured output of the result event", async () => {
      process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-batch.jsonl");
      const r = await new ClaudeAdapter().runBatch(batchOpts);
      expect(r.error).toBeNull();
      expect(r.structured).toEqual({ answers: [{ n: 1, skills: ["find-bug"] }, { n: 2, skills: [] }] });
      expect(r.text).toBe("Here is the survey answer.");
      expect(r.costUsd).toBeCloseTo(0.06, 10);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("has null structured output when the model answered in plain text", async () => {
      process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-batch-text.jsonl");
      const r = await new ClaudeAdapter().runBatch(batchOpts);
      expect(r.error).toBeNull();
      expect(r.structured).toBeNull();
      expect(r.text).toContain("a}b");
    });

    it("kills the run at once when the model loads a skill instead of answering", async () => {
      process.env.FAKE_FIXTURE = path.join(fixtures, "synthetic-batch-skill.jsonl");
      process.env.FAKE_HANG = "1"; // without the kill this would only end on timeout
      const started = Date.now();
      const r = await new ClaudeAdapter().runBatch({ ...batchOpts, timeoutMs: 30_000 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(r.error).toBe("model loaded skill find-bug instead of answering the survey");
      expect(r.structured).toBeNull();
    });
  });
});
