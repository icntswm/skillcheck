#!/usr/bin/env node
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { abortActiveRuns, ClaudeAdapter, DEFAULT_DIRECTIVE } from "./agents/claude.js";
import type { AgentAdapter, RunResult, SkillList } from "./agents/types.js";
import { BATCH_SCHEMA, buildBatchPrompt, parseBatchAnswer } from "./batch.js";
import { Budget } from "./budget.js";
import {
  BUILTIN_SKILLS,
  ConfigError,
  findDefaultCasesFile,
  knownSkillNames,
  loadSuite,
  unknownNames,
  type Case,
  type Suite,
} from "./cases.js";
import { confusion } from "./confusion.js";
import { loadSkillDocs, type SkillDoc } from "./describe.js";
import { aggregate, judge, type CaseResult, type RunVerdict } from "./judge.js";
import { toJunit } from "./junit.js";
import { lint, LINT_DEFAULTS, type LintReport } from "./lint.js";
import { toMarkdown } from "./markdown.js";
import { runPool } from "./pool.js";
import { oneLine, Reporter, type ReportStream } from "./report.js";
import { buildReport } from "./results.js";
import { readVersion } from "./version.js";

const USAGE = `skillcheck — regression tests for agent skill routing

Usage:
  skillcheck run [file] [options]     run cases against an agent
  skillcheck check [file] [options]   validate cases without calling the model
  skillcheck lint [file] [options]    static checks on descriptions and cases
  skillcheck list [options]           print the skills and commands the agent can load
  skillcheck init [file] [options]    write a starter cases file with those names

run options:
  -a, --agent <name>     agent to route with (default: suite or claude)
  -m, --model <name>     model passed to the agent
  -j, --jobs <n>         concurrent runs (default: 4)
      --only <1,2|id>    run only these cases
      --repeat <n>       runs per case (default: suite or 1)
      --threshold <x>    share of runs a case must pass, 0 < x <= 1 (default: suite or 1)
      --timeout <sec>    per-run timeout (default: 180)
      --directive <file> replace the stop directive sent with every query
      --no-early-stop    let the agent finish its turn instead of killing it
      --batch            one model call per chunk of cases instead of one per case
      --batch-size <n>   cases per batch call (default: 25, requires --batch)
      --budget <usd>     stop starting new runs once the spend estimate reaches usd
      --json <path>      machine-readable report to path ("-" writes it to stdout
                         and the terminal report to stderr)
      --junit <path>     JUnit XML report (GitLab/GitHub test reporters) to path
      --markdown <path>  Markdown summary (PR comments, GitHub job summary) to path
run/check options:
      --skill <a,b>      keep only cases that mention these skills
check options:
      --no-name-check    skip matching names against installed skills
lint options:
      --top <n>          flag an expected skill ranked below n (default: 5)
      --overlap <x>      description similarity treated as overlap, 0 < x <= 1 (default: 0.3)
      --strict           exit 1 when lint finds short, similar or far
list/init options:
  -a, --agent <name>     agent to ask (default: claude)
      --timeout <sec>    per-call timeout (same default as run)
      --config-dir <dir> claude config dir: run/check/lint/list/init use it instead of
                         CLAUDE_CONFIG_DIR; run, list and init also set it for the agent
init options:
      --force            overwrite an existing file
common:
  -h, --help             show this help
      --version          show version

lint reads skill descriptions from disk and makes no model calls.
list and init call claude once but kill it right after its init event, so
nothing reaches the model and nothing is billed, even when not logged in.

Exit codes: 0 all passed, 1 some case failed or was skipped, 2 config or environment error.
`;

const OPTIONS = {
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", default: false },
  agent: { type: "string" },
  model: { type: "string" },
  jobs: { type: "string", short: "j" },
  only: { type: "string" },
  repeat: { type: "string" },
  threshold: { type: "string" },
  timeout: { type: "string" },
  directive: { type: "string" },
  "no-early-stop": { type: "boolean", default: false },
  "no-name-check": { type: "boolean", default: false },
  batch: { type: "boolean", default: false },
  "batch-size": { type: "string" },
  skill: { type: "string" },
  budget: { type: "string" },
  json: { type: "string" },
  junit: { type: "string" },
  markdown: { type: "string" },
  top: { type: "string" },
  overlap: { type: "string" },
  strict: { type: "boolean", default: false },
  "config-dir": { type: "string" },
  force: { type: "boolean", default: false },
} satisfies ParseArgsOptionsConfig;

type Values = { [K in keyof typeof OPTIONS]: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string | undefined };

export interface Io {
  stdout: ReportStream;
  stderr: NodeJS.WritableStream;
  cwd: string;
}

/** Config/environment problems: message to stderr, exit 2. */
class UsageError extends Error {}

interface Flags {
  help: boolean;
  version: boolean;
  agent?: string;
  model?: string;
  jobs: number;
  only?: string;
  repeat?: number;
  threshold?: number;
  timeoutSec: number;
  directiveFile?: string;
  earlyStop: boolean;
  nameCheck: boolean;
  batch: boolean;
  batchSize: number;
  skill?: string;
  budget?: number;
  json?: string;
  junit?: string;
  markdown?: string;
  top: number;
  overlap: number;
  strict: boolean;
  configDir?: string;
  force: boolean;
}

function parseFlags(values: Values, cwd: string): Flags {
  if (values["batch-size"] !== undefined && !values.batch) throw new UsageError("--batch-size requires --batch");
  if (values.batch && (values.directive !== undefined || values["no-early-stop"])) {
    throw new UsageError("--directive and --no-early-stop do not apply to --batch");
  }
  return {
    help: values.help,
    version: values.version,
    agent: values.agent,
    model: values.model,
    jobs: intFlag(values.jobs, "jobs", 1) ?? 4,
    only: values.only,
    repeat: intFlag(values.repeat, "repeat", 1),
    threshold: thresholdFlag(values.threshold),
    timeoutSec: intFlag(values.timeout, "timeout", 1) ?? 180,
    directiveFile: values.directive,
    earlyStop: !values["no-early-stop"],
    nameCheck: !values["no-name-check"],
    batch: values.batch,
    batchSize: intFlag(values["batch-size"], "batch-size", 1) ?? 25,
    skill: values.skill,
    budget: numberFlag(values.budget),
    json: values.json,
    junit: values.junit,
    markdown: values.markdown,
    top: intFlag(values.top, "top", 1) ?? 5,
    overlap: ratioFlag(values.overlap) ?? 0.3,
    strict: values.strict,
    configDir: values["config-dir"] !== undefined ? resolveConfigDir(values["config-dir"], cwd) : undefined,
    force: values.force,
  };
}

/** --config-dir: absolute, must be an existing directory. */
function resolveConfigDir(raw: string, cwd: string): string {
  const abs = path.resolve(cwd, raw);
  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {
    // missing => not a directory
  }
  if (!isDir) throw new UsageError(`--config-dir is not a directory: ${abs}`);
  return abs;
}

function intFlag(raw: string | undefined, name: string, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min}`);
  return n;
}

function numberFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError("--budget must be a number > 0");
  return n;
}

function thresholdFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!(n > 0 && n <= 1)) throw new UsageError("--threshold must be a number with 0 < x <= 1");
  return n;
}

function ratioFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!(n > 0 && n <= 1)) throw new UsageError("--overlap must be a number with 0 < x <= 1");
  return n;
}

export async function main(
  argv: string[],
  io: Io = { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd() },
  deps: { adapter?: AgentAdapter } = {},
): Promise<number> {
  let positionals: string[];
  let values: Values;
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    positionals = parsed.positionals;
    values = parsed.values as Values;
  } catch (e) {
    io.stderr.write(`skillcheck: ${(e as Error).message}\n`);
    return 2;
  }

  try {
    if (values.help) {
      io.stdout.write(USAGE);
      return 0;
    }
    if (values.version) {
      io.stdout.write(`${readVersion()}\n`);
      return 0;
    }
    const command = positionals[0];
    if (!command) {
      io.stderr.write(USAGE);
      return 2;
    }
    if (command !== "run" && command !== "check" && command !== "lint" && command !== "list" && command !== "init") {
      io.stderr.write(`skillcheck: unknown command "${command}"\n\n${USAGE}`);
      return 2;
    }
    const flags = parseFlags(values, io.cwd);
    if (command === "lint") return await lintCommand(positionals[1], flags, io);
    if (command === "list") return await listCommand(flags, io, deps);
    if (command === "init") return await initCommand(positionals[1], flags, io, deps);
    const file = casesFile(positionals[1], io);
    if (command === "run") return await runCommand(file, flags, io, deps);
    return await checkCommand(file, flags, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`skillcheck: ${e.message}\n`);
      return 2;
    }
    if (e instanceof ConfigError) {
      printConfigError(io.stderr, "cases file", e);
      return 2;
    }
    io.stderr.write(`skillcheck: ${(e as Error).message}\n`);
    return 2;
  }
}

function casesFile(positional: string | undefined, io: Io): string {
  if (positional) return positional;
  const found = findDefaultCasesFile(io.cwd);
  if (!found) throw new UsageError("no cases file: pass a path or create skillcheck.yaml");
  return found;
}

async function loadCases(file: string, io: Io): Promise<Suite | null> {
  try {
    return await loadSuite(file);
  } catch (e) {
    if (e instanceof ConfigError) {
      printConfigError(io.stderr, file, e);
      return null;
    }
    throw e;
  }
}

function printConfigError(stderr: NodeJS.WritableStream, file: string, err: ConfigError): void {
  const prefix = `skillcheck: ${file}: `;
  if (err.errors.length <= 3) {
    stderr.write(prefix + err.errors.join("; ") + "\n");
  } else {
    stderr.write(prefix + "\n");
    for (const message of err.errors) stderr.write(`  ${message}\n`);
  }
}

async function checkCommand(file: string, flags: Flags, io: Io): Promise<number> {
  const suite = await loadCases(file, io);
  if (!suite) return 2;
  const cases = applySkillFilter(suite.cases, flags.skill);
  if (flags.nameCheck) {
    const errors = unknownNames({ ...suite, cases }, knownSkillNames({ cwd: io.cwd, configDir: flags.configDir }));
    if (errors.length > 0) {
      printConfigError(io.stderr, file, new ConfigError(errors));
      return 2;
    }
  }
  io.stdout.write(`${file}: ${cases.length} cases, ok\n`);
  return 0;
}

async function lintCommand(positional: string | undefined, flags: Flags, io: Io): Promise<number> {
  let suite: Suite | null;
  const file = positional ?? findDefaultCasesFile(io.cwd);
  if (file) {
    suite = await loadCases(file, io);
    if (!suite) return 2; // loadCases already printed the errors
  } else {
    suite = null;
  }
  const docs = loadSkillDocs({ cwd: io.cwd, configDir: flags.configDir });
  const report = lint(docs, suite, { top: flags.top, overlap: flags.overlap, minLength: LINT_DEFAULTS.minLength });
  printLint(io.stdout, report, docs, suite);
  if (flags.strict && (report.short.length || report.similar.length || report.far.length)) return 1;
  return 0;
}

async function listCommand(flags: Flags, io: Io, deps: { adapter?: AgentAdapter }): Promise<number> {
  const adapter = pickAdapter(flags.agent ?? "claude", io, deps);
  if (!adapter) return 2;
  if (!adapter.listSkills) {
    io.stderr.write(`skillcheck: agent ${adapter.name} has no list mode\n`);
    return 2;
  }
  const list = await adapter.listSkills({ configDir: flags.configDir, timeoutMs: flags.timeoutSec * 1000 });
  if (list.error) {
    io.stderr.write(`skillcheck: ${list.error}\n`);
    return 2;
  }
  io.stdout.write(`skills (${list.skills.length}):\n`);
  for (const name of list.skills) io.stdout.write(`  ${name}\n`);
  io.stdout.write(`other slash commands (${list.slashCommands.length}):\n`);
  for (const name of list.slashCommands) io.stdout.write(`  ${name}\n`);
  return 0;
}

const INIT_LIST_WIDTH = 76; // plus the "# " prefix the line stays within 78 columns

/** The names block of the init template: a header line plus comma-wrapped "#   …" lines. */
function nameListBlock(header: string, names: string[]): string[] {
  if (names.length === 0) return [header, "#   (none)"];
  const wrapped = wrapNames(names, INIT_LIST_WIDTH).split("\n").map((line) => `# ${line}`);
  return [header, ...wrapped];
}

function initTemplate(agent: string, skills: string[], slashCommands: string[]): string {
  // the sample case should name something the user plausibly owns, not a built-in
  const alpha = skills.find((s) => !BUILTIN_SKILLS.includes(s)) ?? "my-skill";
  const lines = [
    "# skillcheck cases: each query is sent to the agent with a stop directive,",
    "# and the skills it loads are checked against the expectations below.",
    "# Fields per case: query (required), expect, expect_any, forbid, first, none,",
    "# note, id, repeat, threshold, agents. Docs: https://github.com/icntswm/skillcheck",
    "#",
    "# Cheapest first: `skillcheck lint` (no model calls), `skillcheck run --batch`",
    "# (one call per 25 cases), `skillcheck run` (one call per case and repeat).",
    "#",
    ...nameListBlock(`# Skills available to ${agent}:`, skills),
  ];
  if (slashCommands.length > 0) lines.push(...nameListBlock("# Other slash commands:", slashCommands));
  lines.push(
    `agent: ${agent}`,
    "# model: sonnet",
    "repeat: 1",
    "threshold: 1.0",
    "cases:",
    `  - query: "replace with a request that should load ${alpha}"`,
    `    expect: [${alpha}]`,
    '  - query: "what is 2 + 2?"',
    "    none: true",
  );
  return lines.join("\n") + "\n";
}

async function initCommand(
  positional: string | undefined,
  flags: Flags,
  io: Io,
  deps: { adapter?: AgentAdapter },
): Promise<number> {
  const file = positional ?? path.join(io.cwd, "skillcheck.yaml");
  if (fs.existsSync(file) && !flags.force) {
    throw new UsageError(`${file} exists, use --force to overwrite`);
  }
  const adapter = pickAdapter(flags.agent ?? "claude", io, deps);
  if (!adapter) return 2;
  let skills: string[] = [];
  let slashCommands: string[] = [];
  const list: SkillList | null = adapter.listSkills
    ? await adapter.listSkills({ configDir: flags.configDir, timeoutMs: flags.timeoutSec * 1000 })
    : null;
  if (list && !list.error) {
    skills = list.skills;
    slashCommands = list.slashCommands;
  } else {
    // a missing or failing agent must not block writing the starter file
    const why = list?.error ?? `agent ${adapter.name} has no list mode`;
    io.stderr.write(`note: could not ask the agent (${why}); listed skills found on disk\n`);
    skills = [...knownSkillNames({ cwd: io.cwd, configDir: flags.configDir })].sort();
  }
  try {
    fs.writeFileSync(file, initTemplate(flags.agent ?? "claude", skills, slashCommands));
  } catch (e) {
    throw new UsageError(`cannot write ${file}: ${(e as Error).message}`);
  }
  io.stdout.write(`wrote ${file} (${skills.length} skills listed)\n`);
  return 0;
}

const UNCOVERED_WIDTH = 78;

function printLint(out: ReportStream, report: LintReport, docs: SkillDoc[], suite: Suite | null): void {
  const casesPart = suite ? `${report.cases} cases` : "no cases file";
  out.write(`lint: ${report.docs} skills and commands with descriptions, ${casesPart}\n`);

  if (report.short.length) {
    out.write(`short descriptions (${report.short.length}):\n`);
    for (const s of report.short) out.write(`  ${s.name}  ${s.kind}, ${s.length} chars\n`);
  }
  if (report.similar.length) {
    out.write(`similar descriptions (${report.similar.length}):\n`);
    for (const p of report.similar) out.write(`  ${p.a} ↔ ${p.b}  ${p.score.toFixed(2)}\n`);
  }
  if (report.far.length) {
    out.write(`expected skill far from the query (${report.far.length}):\n`);
    for (const f of report.far) {
      const label = `#${f.id ?? f.index}`;
      out.write(`  ${label}  ${oneLine(f.query)}  → ${f.expected} ranked ${f.rank} (top: ${f.top.join(", ")})\n`);
    }
  }
  if (report.uncovered.length) {
    const nSkills = docs.filter((d) => d.kind === "skill").length;
    out.write(`uncovered skills (${report.uncovered.length} of ${nSkills}):\n`);
    out.write(`${wrapNames(report.uncovered, UNCOVERED_WIDTH)}\n`);
  }
  const clean = !report.short.length && !report.similar.length && !report.far.length && !report.uncovered.length;
  if (clean) out.write("no problems found\n");
}

/** Comma-separated names, line-wrapped to width with a two-space indent;
 * every line but the last ends with a comma so the list reads as one. */
function wrapNames(names: string[], width: number): string {
  const lines: string[] = [];
  let line = "  ";
  for (const name of names) {
    const piece = line === "  " ? name : `, ${name}`;
    if (line !== "  " && line.length + piece.length > width) {
      lines.push(`${line},`);
      line = `  ${name}`;
    } else {
      line += piece;
    }
  }
  if (line !== "  ") lines.push(line);
  return lines.join("\n");
}

/** Only claude exists at this stage; an injected adapter is accepted by name. */
function pickAdapter(agent: string, io: Io, deps: { adapter?: AgentAdapter }): AgentAdapter | null {
  if (agent === "claude") return deps.adapter ?? new ClaudeAdapter();
  if (deps.adapter && deps.adapter.name === agent) return deps.adapter;
  io.stderr.write(`skillcheck: unknown agent "${agent}" (available: ${deps.adapter ? `claude, ${deps.adapter.name}` : "claude"})\n`);
  return null;
}

interface PlanItem {
  c: Case;
  /** position in file order, the slot in the results array */
  jobIndex: number;
  threshold: number;
  runs: (RunVerdict | undefined)[];
  done: number;
}

interface RunOutcome {
  /** indexed by jobIndex; an undefined slot means the budget skipped the case */
  results: (CaseResult | undefined)[];
  available: Set<string>;
  sawAvailability: boolean;
}

/** Errors that every other run would repeat: stop instead of failing each case. */
const FATAL_ERROR = /Not logged in|Failed to authenticate|invalid x-api-key|OAuth access token|API Error: 401/i;

/** Remembers the first fatal run error; the pool stops starting new runs after it. */
class FatalStop {
  message: string | null = null;
  note(error: string | null): void {
    if (this.message === null && error !== null && FATAL_ERROR.test(error)) this.message = error;
  }
  canStart(budget: Budget): boolean {
    return this.message === null && !budget.exceeded;
  }
}

async function runCommand(file: string, flags: Flags, io: Io, deps: { adapter?: AgentAdapter }): Promise<number> {
  const suite = await loadCases(file, io);
  if (!suite) return 2;

  const agent = flags.agent ?? suite.agent;
  const adapter = pickAdapter(agent, io, deps);
  if (!adapter) return 2;
  const model = flags.model ?? suite.model;
  const repeat = flags.repeat ?? suite.repeat;
  const threshold = flags.threshold ?? suite.threshold;
  const directive = await readDirective(flags.directiveFile);
  if (flags.batch && !adapter.runBatch) throw new UsageError(`agent ${agent} has no batch mode`);

  const byOnly = selectCases(suite, agent, flags.only);
  if (byOnly.length === 0) {
    throw new UsageError(`no cases to run (${flags.only ? `--only ${flags.only} matches nothing` : `no cases for agent "${agent}"`})`);
  }
  const selected = applySkillFilter(byOnly, flags.skill);

  const items: PlanItem[] = selected.map((c, i) => {
    const n = c.repeat ?? repeat;
    return { c, jobIndex: i, threshold: c.threshold ?? threshold, runs: Array.from<RunVerdict | undefined>({ length: n }), done: 0 };
  });

  // without --budget it only estimates the spend for the report
  const budget = new Budget(flags.budget ?? Infinity);
  // "--json -" owns stdout, so the human report has to go to stderr
  const reporter = new Reporter(flags.json === "-" ? (io.stderr as ReportStream) : io.stdout);
  const startedAtMs = Date.now();
  const fatal = new FatalStop();
  const outcome = flags.batch
    ? await runBatched(adapter.runBatch!.bind(adapter), items, flags, model, repeat, reporter, budget, fatal)
    : await runIndividually(adapter, items, flags, model, directive, repeat, reporter, budget, fatal);
  if (fatal.message !== null) {
    // an environment problem, not a routing result: no summary, no reports
    io.stderr.write(`skillcheck: stopped, the agent cannot run: ${fatal.message}\n`);
    return 2;
  }

  // budget-skipped cases print after the pool settles, in file order
  const skipped = items.filter((item) => outcome.results[item.jobIndex] === undefined);
  for (const item of skipped) reporter.caseSkipped(item.c);
  const notStartedRuns = skipped.reduce((n, item) => n + item.runs.length - item.done, 0);

  const ordered = outcome.results.filter((r): r is CaseResult => r !== undefined);
  const expected = expectedNames(selected);
  const unavailable = outcome.sawAvailability ? expected.filter((name) => !outcome.available.has(name)) : [];
  const pairs = confusion(ordered);
  reporter.summary(ordered, {
    unavailable,
    confusion: pairs,
    skipped: skipped.length,
    budget: skipped.length > 0 ? { limitUsd: flags.budget!, spent: budget.spent, notStartedRuns } : undefined,
    estimatedUsd: budget.spent,
  });
  if (flags.batch) {
    // cases that only errored have no answer to confirm
    const failed = ordered
      .filter((r) => r.runs.some((v) => !v.ok && v.error === null))
      .map((r) => String(r.case.id ?? r.case.index));
    const hint = failed.length > 0 ? ` (--only ${failed.join(",")})` : "";
    reporter.note(`batch mode: answers are the model's stated choice, not an actual Skill call — confirm failures with a normal run${hint}`);
  }

  const report = buildReport({
    file,
    agent,
    model: model ?? null,
    startedAtMs,
    durationMs: Date.now() - startedAtMs,
    cases: items.map((item) => ({ c: item.c, threshold: item.threshold, result: outcome.results[item.jobIndex] ?? null })),
    unavailable,
    confusion: pairs,
    batch: flags.batch,
    estimatedCostUsd: budget.spent,
    budgetUsd: flags.budget ?? null,
    budgetReached: skipped.length > 0,
  });
  if (flags.json !== undefined) {
    const payload = JSON.stringify(report, null, 2) + "\n";
    if (flags.json === "-") io.stdout.write(payload);
    else writeReportFile(flags.json, payload, "--json");
  }
  if (flags.junit !== undefined) writeReportFile(flags.junit, toJunit(report), "--junit");
  if (flags.markdown !== undefined) writeReportFile(flags.markdown, toMarkdown(report), "--markdown");

  return ordered.some((r) => !r.ok) || skipped.length > 0 ? 1 : 0;
}

function writeReportFile(path: string, text: string, flag: string): void {
  try {
    fs.writeFileSync(path, text);
  } catch (e) {
    throw new UsageError(`cannot write ${flag} ${path}: ${(e as Error).message}`);
  }
}

/** One agent call per case: the normal mode. */
async function runIndividually(
  adapter: AgentAdapter,
  items: PlanItem[],
  flags: Flags,
  model: string | undefined,
  directive: string,
  repeat: number,
  reporter: Reporter,
  budget: Budget,
  fatal: FatalStop,
): Promise<RunOutcome> {
  const totalRuns = items.reduce((n, item) => n + item.runs.length, 0);
  reporter.header(items.length, repeat, 1, totalRuns);

  const jobs = items.flatMap((item, jobIndex) =>
    item.runs.map((_, runIndex) => ({ item, runIndex, jobIndex })),
  );
  // keep cases in file order even though runs of different cases interleave
  const results: (CaseResult | undefined)[] = new Array(items.length);

  const available = new Set<string>();
  let sawAvailability = false;

  await runPool(jobs, flags.jobs, async (job) => {
    const r = await adapter.run({
      query: job.item.c.query,
      directive,
      model,
      timeoutMs: flags.timeoutSec * 1000,
      earlyStop: flags.earlyStop,
      configDir: flags.configDir,
    });
    fatal.note(r.error);
    if (r.availableSkills) {
      sawAvailability = true;
      for (const name of r.availableSkills) available.add(name);
    }
    const verdict = judge(job.item.c, r);
    budget.add(r.costUsd, r.usage);
    job.item.runs[job.runIndex] = verdict;
    job.item.done++;
    if (job.item.done === job.item.runs.length) {
      const res = aggregate(job.item.c, job.item.runs as RunVerdict[], job.item.threshold);
      results[job.item.jobIndex] = res;
      reporter.caseDone(res);
    }
    return verdict;
  }, { shouldStart: () => fatal.canStart(budget) });

  return { results, available, sawAvailability };
}

/** One agent call per chunk of cases; the model states its choice per request
 * instead of loading skills. Verdicts flow through the same judge. */
async function runBatched(
  runBatch: NonNullable<AgentAdapter["runBatch"]>,
  items: PlanItem[],
  flags: Flags,
  model: string | undefined,
  repeat: number,
  reporter: Reporter,
  budget: Budget,
  fatal: FatalStop,
): Promise<RunOutcome> {
  const chunks: PlanItem[][] = [];
  for (let i = 0; i < items.length; i += flags.batchSize) chunks.push(items.slice(i, i + flags.batchSize));
  const rounds = Math.max(...items.map((item) => item.runs.length));
  const jobs: { chunk: PlanItem[]; round: number }[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const chunk of chunks) jobs.push({ chunk, round });
  }
  reporter.batchHeader(items.length, repeat, chunks.length * rounds);

  const results: (CaseResult | undefined)[] = new Array(items.length);
  await runPool(jobs, flags.jobs, async (job) => {
    // a case with a smaller repeat only takes its first rounds
    const active = job.chunk.filter((item) => job.round < item.runs.length);
    if (active.length === 0) return;
    const prompt = buildBatchPrompt(active.map((item, i) => ({ n: i + 1, query: item.c.query })));
    const br = await runBatch({ prompt, schema: BATCH_SCHEMA, model, timeoutMs: flags.timeoutSec * 1000, configDir: flags.configDir });
    const parsed = parseBatchAnswer(br.structured, br.text);
    const chunkError = br.error ?? parsed.error; // a chunk error is every case's error
    fatal.note(br.error);
    active.forEach((item, i) => {
      const answer = parsed.answers.get(i + 1);
      const r: RunResult = {
        loaded: answer ?? [],
        text: "",
        costUsd: br.costUsd === null ? null : br.costUsd / active.length,
        availableSkills: null,
        error: chunkError ?? (answer === undefined ? "no answer for this case in the batch" : null),
        stoppedEarly: false,
        durationMs: br.durationMs,
      };
      const verdict = judge(item.c, r);
      budget.add(verdict.costUsd);
      item.runs[job.round] = verdict;
      item.done++;
      if (item.done === item.runs.length) {
        const res = aggregate(item.c, item.runs as RunVerdict[], item.threshold);
        results[item.jobIndex] = res;
        reporter.caseDone(res);
      }
    });
  }, { shouldStart: () => fatal.canStart(budget) });

  return { results, available: new Set<string>(), sawAvailability: false };
}

function selectCases(suite: Suite, agent: string, only?: string): Case[] {
  const forAgent = suite.cases.filter((c) => !c.agents || c.agents.includes(agent));
  if (!only) return forAgent;
  const tokens = only.split(",").map((t) => t.trim()).filter((t) => t !== "");
  return forAgent.filter((c) => tokens.includes(String(c.index)) || (c.id !== undefined && tokens.includes(c.id)));
}

/** Cases mentioning any of the named skills in expect, expect_any, forbid or first. */
function applySkillFilter(cases: Case[], skill: string | undefined): Case[] {
  if (skill === undefined) return cases;
  const names = new Set(skill.split(",").map((t) => t.trim()).filter((t) => t !== ""));
  const kept = cases.filter((c) =>
    [...c.expect, ...c.expect_any, ...c.forbid, ...(c.first ? [c.first] : [])].some((n) => names.has(n)),
  );
  if (kept.length === 0) throw new UsageError(`no cases match --skill ${skill}`);
  return kept;
}

function expectedNames(cases: Case[]): string[] {
  const names: string[] = [];
  for (const c of cases) {
    for (const name of [...c.expect, ...c.expect_any, ...(c.first ? [c.first] : [])]) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

async function readDirective(file: string | undefined): Promise<string> {
  if (!file) return DEFAULT_DIRECTIVE;
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (e) {
    throw new UsageError(`cannot read directive ${file}: ${(e as Error).message}`);
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // agent runs are detached process groups that Ctrl+C does not reach
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(signal, () => {
      // a second Ctrl+C during the grace period exits at once
      process.once(signal, () => process.exit(code));
      void abortActiveRuns().finally(() => process.exit(code));
    });
  }
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
