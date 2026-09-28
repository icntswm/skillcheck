export interface RunOptions {
  query: string;
  directive: string;
  model?: string;
  timeoutMs: number;
  earlyStop: boolean;
  /** claude config dir, passed to the child as CLAUDE_CONFIG_DIR */
  configDir?: string;
  pluginDirs?: string[];
}

/** Billed tokens of one run, as the API reports them. */
export interface TokenUsage {
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface RunResult {
  /** Skill names, first-seen order, deduped, leading "/" stripped */
  loaded: string[];
  /** answer text */
  text: string;
  /** total_cost_usd from result event, null if absent */
  costUsd: number | null;
  /** tokens billed so far; lets --budget price runs killed before costUsd arrives */
  usage?: TokenUsage | null;
  /** from system/init event `skills`, null if absent */
  availableSkills: string[] | null;
  /** run failure, null otherwise */
  error: string | null;
  stoppedEarly: boolean;
  durationMs: number;
}

export interface BatchOptions {
  prompt: string;
  schema: object;
  model?: string;
  timeoutMs: number;
  /** claude config dir, passed to the child as CLAUDE_CONFIG_DIR */
  configDir?: string;
  pluginDirs?: string[];
}

export interface BatchResult {
  /** structured_output from the result event, null when absent */
  structured: unknown;
  /** answer text */
  text: string;
  costUsd: number | null;
  /** tokens used, to price a call killed before it reported its cost */
  usage?: TokenUsage | null;
  error: string | null;
  durationMs: number;
}

export interface SkillList {
  skills: string[];
  slashCommands: string[];
  error: string | null;
}

export interface AgentAdapter {
  name: string;
  version?(): Promise<string | null>;
  run(opts: RunOptions): Promise<RunResult>;
  /** one call answers many cases; agents without batch mode omit it */
  runBatch?(opts: BatchOptions): Promise<BatchResult>;
  /** ask the agent what it can load; agents without this omit it */
  listSkills?(opts: { configDir?: string; pluginDirs?: string[]; timeoutMs: number }): Promise<SkillList>;
}
