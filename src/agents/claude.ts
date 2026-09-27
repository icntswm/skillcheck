import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentAdapter, BatchOptions, BatchResult, RunOptions, RunResult, SkillList } from "./types.js";

export const DEFAULT_DIRECTIVE =
  // "Decide which skill fits" made sonnet answer with the name as text instead
  // of calling the tool (0 of 6 runs); naming the Skill tool fixes it (5 of 6).
  '[SKILL ROUTING CHECK] Invoke the Skill tool with the skill that fits this request. ' +
  'Then stop immediately: no questions, no external sources, no file changes, no subagents. ' +
  'If no skill fits, answer "none" and do not invoke any skill.';

type Json = Record<string, unknown>;

function stringList(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null;
}

/**
 * Incremental parser of claude's stream-json stdout. One event per line.
 * Pushing lines also computes the early-stop signal, so the adapter can
 * kill the process as soon as routing is decided.
 */
export class ClaudeStream {
  private loaded: string[] = [];
  private textParts: string[] = [];
  private resultText = "";
  private sawResult = false;
  private costUsd: number | null = null;
  private availableSkills: string[] | null = null;
  private initSkillList: string[] | null = null;
  private initSlashList: string[] | null = null;
  private sawInitEvent = false;
  private sawSkill = false;
  private structuredOutput: unknown = null;
  private failure: string | null = null;

  /** Raw `skills` from the init event, null until init is parsed. */
  get initSkills(): string[] | null {
    return this.initSkillList;
  }

  /** Raw `slash_commands` from the init event, null until init is parsed. */
  get initSlashCommands(): string[] | null {
    return this.initSlashList;
  }

  /** True after the init event: the two lists above are then complete. */
  get sawInit(): boolean {
    return this.sawInitEvent;
  }

  /** True after the result event: the run is over, nothing more will come. */
  get finished(): boolean {
    return this.sawResult;
  }

  /** Feed one stdout line; true means the run can be stopped early. */
  push(line: string): boolean {
    if (!line.startsWith("{")) return false;
    let ev: Json;
    try {
      ev = JSON.parse(line) as Json;
    } catch {
      return false;
    }
    if (ev.type === "system" && ev.subtype === "init") {
      this.sawInitEvent = true;
      this.initSkillList = stringList(ev.skills);
      this.initSlashList = stringList(ev.slash_commands);
      // Commands (~/.claude/commands) are loadable through Skill too, but init
      // lists them only in slash_commands, so take the union.
      const names = [...(this.initSkillList ?? []), ...(this.initSlashList ?? [])];
      if (this.initSkillList || this.initSlashList) {
        this.availableSkills = [...new Set(names)];
      }
      return false;
    }
    if (ev.type === "assistant") {
      const hadSkillBefore = this.sawSkill;
      const hasSkill = this.handleAssistant(ev);
      // Stop on the first assistant event without a Skill call that follows
      // a Skill event; a second Skill keeps the run going (multi-skill cases).
      return hadSkillBefore && !hasSkill;
    }
    if (ev.type === "result") {
      this.sawResult = true;
      this.resultText = typeof ev.result === "string" ? ev.result : "";
      this.structuredOutput = ev.structured_output ?? null;
      // error_max_turns is the normal end of a routing probe; any other error
      // (usage limit, API failure, structured output retries exhausted) means
      // the model never got to route.
      if (ev.is_error === true && ev.subtype !== "error_max_turns") {
        this.failure = `claude error: ${this.resultText.trim().slice(0, 120) || String(ev.subtype)}`;
      }
      if (typeof ev.total_cost_usd === "number") this.costUsd = ev.total_cost_usd;
      return true;
    }
    return false;
  }

  private handleAssistant(ev: Json): boolean {
    const message = ev.message as Json | undefined;
    const blocks = message?.content;
    if (!Array.isArray(blocks)) return false;
    let sawSkillHere = false;
    for (const raw of blocks) {
      if (typeof raw !== "object" || raw === null) continue;
      const block = raw as Json;
      if (block.type === "tool_use" && block.name === "Skill") {
        const input = block.input as Json | undefined;
        const rawName = input?.skill ?? input?.command ?? input?.name;
        const name = String(rawName ?? "").replace(/^\/+/, "");
        if (name && !this.loaded.includes(name)) this.loaded.push(name);
        sawSkillHere = true;
      } else if (block.type === "text" && typeof block.text === "string") {
        this.textParts.push(block.text);
      }
    }
    if (sawSkillHere) this.sawSkill = true;
    return sawSkillHere;
  }

  /** Error reported by claude itself in the result event, null if none. */
  get error(): string | null {
    return this.failure;
  }

  get result(): {
    loaded: string[];
    text: string;
    costUsd: number | null;
    availableSkills: string[] | null;
    structuredOutput: unknown;
  } {
    const text = this.sawResult && this.resultText !== ""
      ? this.resultText
      : this.textParts.join("\n");
    return {
      loaded: this.loaded,
      text,
      costUsd: this.costUsd,
      availableSkills: this.availableSkills,
      structuredOutput: this.structuredOutput,
    };
  }
}

export function parseClaudeStream(stdout: string): ClaudeStream["result"] {
  const stream = new ClaudeStream();
  for (const line of stdout.split("\n")) stream.push(line); // stop signal ignored here
  return stream.result;
}

const DISALLOWED_TOOLS = [
  "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit",
  "Agent", "Task", "WebFetch", "WebSearch", "mcp__*",
];

const STDERR_CAP = 4096;
const KILL_GRACE_MS = 2000;

function claudeArgs(opts: RunOptions): string[] {
  const args = [
    "-p", `${opts.query}\n\n${opts.directive}`,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "2",
    "--permission-mode", "plan",
    "--allowedTools", "Skill",
    "--disallowedTools", ...DISALLOWED_TOOLS,
  ];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

function batchArgs(opts: BatchOptions): string[] {
  // Skill is NOT disallowed here: removing the tool may also remove the skill
  // list the model has to reason about; the survey is enforced by killing the
  // process the moment a Skill call appears instead.
  const args = [
    "-p", opts.prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "3",
    "--permission-mode", "plan",
    "--json-schema", JSON.stringify(opts.schema),
    "--disallowedTools", ...DISALLOWED_TOOLS,
  ];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

function listArgs(): string[] {
  // The init event arrives before any model call, so the process is killed
  // before anything is billed; the disallow list is a guard for that race.
  return [
    "-p", "none",
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "1",
    "--permission-mode", "plan",
    "--disallowedTools", ...DISALLOWED_TOOLS,
  ];
}

/** Seconds as written in the timeout message: 180000 -> "180", 400 -> "0.4". */
function seconds(ms: number): string {
  return String(Math.round((ms / 1000) * 100) / 100);
}

function spawnErrorMessage(e: unknown, bin: string): string {
  const err = e as NodeJS.ErrnoException;
  if (err.code === "ENOENT") return `${bin} not found`;
  return `spawn failed: ${err.message}`;
}

interface StreamRun {
  stream: ClaudeStream;
  error: string | null;
  stoppedEarly: boolean;
  durationMs: number;
}

/** Live runs by process group id, with their tmp dirs; see abortActiveRuns. */
const active = new Map<number, string>();

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill every running claude group and remove its tmp dir. Runs are detached
 * process groups, so Ctrl+C on skillcheck does not reach them: without this
 * they keep running (and billing) after skillcheck exits. Groups still alive
 * after graceMs get SIGKILL, so a process that ignores SIGTERM dies too.
 */
export async function abortActiveRuns(graceMs = KILL_GRACE_MS): Promise<void> {
  const runs = [...active];
  active.clear();
  for (const [pid] of runs) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // already exited
    }
  }
  const deadline = Date.now() + graceMs;
  while (runs.some(([pid]) => groupAlive(pid)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const [pid, workdir] of runs) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already exited
    }
    rmSync(workdir, { recursive: true, force: true });
  }
}

const LOGIN_HINT = " — with --config-dir, auth comes from ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)";

/** A fresh config dir has no credentials; point the user at the env vars. */
function withLoginHint(error: string | null, configDir: string | undefined): string | null {
  if (error && configDir && error.includes("Not logged in")) return error + LOGIN_HINT;
  return error;
}

/**
 * Runs `claude -p` in a throwaway directory and reads its stream-json stdout
 * incrementally, so the process can be killed as soon as routing is decided.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude";

  async run(opts: RunOptions): Promise<RunResult> {
    const bin = process.env.SKILLCHECK_CLAUDE_BIN || "claude";
    const workdir = await mkdtemp(path.join(os.tmpdir(), "skillcheck-"));
    try {
      const out = await this.streamRun(bin, claudeArgs(opts), workdir, opts.timeoutMs, {
        earlyStop: opts.earlyStop,
        configDir: opts.configDir,
      });
      const { loaded, text, costUsd, availableSkills } = out.stream.result;
      const error = withLoginHint(out.error, opts.configDir);
      return { loaded, text, costUsd, availableSkills, error, stoppedEarly: out.stoppedEarly, durationMs: out.durationMs };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  async runBatch(opts: BatchOptions): Promise<BatchResult> {
    const bin = process.env.SKILLCHECK_CLAUDE_BIN || "claude";
    const workdir = await mkdtemp(path.join(os.tmpdir(), "skillcheck-"));
    try {
      const out = await this.streamRun(bin, batchArgs(opts), workdir, opts.timeoutMs, {
        earlyStop: false, // the run ends with the result event
        configDir: opts.configDir,
        abandon: (stream) => {
          const { loaded } = stream.result;
          const skill = loaded[loaded.length - 1];
          return skill !== undefined ? `model loaded skill ${skill} instead of answering the survey` : null;
        },
      });
      const { text, costUsd, structuredOutput } = out.stream.result;
      return { structured: structuredOutput, text, costUsd, error: withLoginHint(out.error, opts.configDir), durationMs: out.durationMs };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  /** Ask the agent for its skill lists; killed right after init, so no model call. */
  async listSkills(opts: { configDir?: string; timeoutMs: number }): Promise<SkillList> {
    const bin = process.env.SKILLCHECK_CLAUDE_BIN || "claude";
    const workdir = await mkdtemp(path.join(os.tmpdir(), "skillcheck-"));
    try {
      const out = await this.streamRun(bin, listArgs(), workdir, opts.timeoutMs, {
        earlyStop: false,
        configDir: opts.configDir,
        stop: (stream) => stream.sawInit,
      });
      if (out.error || !out.stream.sawInit) {
        return { skills: [], slashCommands: [], error: out.error ?? "claude sent no init event" };
      }
      const skills = [...new Set(out.stream.initSkills ?? [])].sort();
      const skillSet = new Set(skills);
      const slashCommands = [...new Set((out.stream.initSlashCommands ?? []).filter((s) => !skillSet.has(s)))].sort();
      return { skills, slashCommands, error: null };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  /**
   * Shared spawn-and-parse loop. `earlyStop` enables the stream's stop signal;
   * `abandon` runs after every event and, when it returns a message, the group
   * is killed at once and that message becomes the run error. `stop` kills the
   * group the same way but is not an error (used to end right after init).
   */
  private streamRun(
    bin: string,
    args: string[],
    workdir: string,
    timeoutMs: number,
    control: {
      earlyStop: boolean;
      configDir?: string;
      abandon?: (stream: ClaudeStream) => string | null;
      stop?: (stream: ClaudeStream) => boolean;
    },
  ): Promise<StreamRun> {
    return new Promise<StreamRun>((resolve) => {
      const startedAt = Date.now();
      const stream = new ClaudeStream();
      const env = { ...process.env } as NodeJS.ProcessEnv;
      delete env.CLAUDE_PROJECT_DIR; // the probe must not see the caller's project
      if (control.configDir) env.CLAUDE_CONFIG_DIR = control.configDir;

      let child: ChildProcess | undefined;
      let tail = "";
      let stdoutSeen = false;
      let stderrText = "";
      let error: string | null = null;
      let stoppedEarly = false;
      let stopping = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;

      // detached => child.pid is the process group id; ESRCH means it is gone
      const killGroup = (pid: number) => {
        clearTimeout(timeoutTimer); // the run is ending anyway, a late timeout must not overwrite its outcome
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // already exited
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // already exited
          }
        }, KILL_GRACE_MS);
        killTimer.unref();
      };

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        if (child?.pid) active.delete(child.pid);
        if (killTimer) clearTimeout(killTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        // A non-zero exit is not a failure by itself: error_max_turns is normal.
        // Only a stdout with nothing in it means the run really did not happen.
        if (!error) error = stream.error;
        if (!error && !stdoutSeen) {
          const detail = stderrText.trim().slice(0, 120);
          error = `claude exited with code ${code ?? signal}${detail ? `: ${detail}` : ""}`;
        }
        resolve({ stream, error, stoppedEarly, durationMs: Date.now() - startedAt });
      };

      try {
        child = spawn(bin, args, { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      } catch (e) {
        error = spawnErrorMessage(e, bin);
        finish(null, null);
        return;
      }
      const proc = child;
      if (proc.pid) active.set(proc.pid, workdir);

      proc.on("error", (e) => {
        if (!error) error = spawnErrorMessage(e, bin);
      });

      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        if (!stdoutSeen && chunk.trim() !== "") stdoutSeen = true;
        const lines = (tail + chunk).split("\n");
        tail = lines.pop() as string; // the unfinished last line waits for the next chunk
        for (const line of lines) {
          const stop = stream.push(line); // always parse: stop and abandon only gate the kill
          if (error) continue; // first failure wins, the group is already being killed
          const abandoned = control.abandon?.(stream);
          if (abandoned) {
            error = abandoned;
            if (proc.pid) killGroup(proc.pid);
          } else if (!stopping && ((control.earlyStop && stop) || control.stop?.(stream) === true)) {
            stopping = true;
            // after the result event the run is complete: the kill only reaps the process
            stoppedEarly = !stream.finished;
            if (proc.pid) killGroup(proc.pid);
          }
        }
      });

      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        if (stderrText.length < STDERR_CAP) stderrText += chunk.slice(0, STDERR_CAP - stderrText.length);
      });

      timeoutTimer = setTimeout(() => {
        error = `timeout after ${seconds(timeoutMs)}s`;
        if (proc.pid) killGroup(proc.pid);
      }, timeoutMs);
      timeoutTimer.unref();

      proc.on("close", (code, signal) => {
        if (tail.trim() !== "") stream.push(tail); // last partial line
        finish(code, signal);
      });
    });
  }
}
