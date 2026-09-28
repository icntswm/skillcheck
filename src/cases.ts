import { readFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { commandNames, loadSkillDocs, skillDirNames, skillRoots } from "./describe.js";

export interface Case {
  index: number; // 1-based position in file
  id?: string;
  query: string;
  expect: string[];
  expect_any: string[];
  forbid: string[];
  first?: string;
  none: boolean;
  note?: string;
  repeat?: number;
  threshold?: number;
  agents?: string[];
}

export interface Suite {
  agent: string;
  model?: string;
  repeat: number;
  threshold: number;
  cases: Case[];
}

export class ConfigError extends Error {
  constructor(public errors: string[]) {
    super(errors.join("; "));
    this.name = "ConfigError";
  }
}

const CASE_KEYS = [
  "query", "expect", "expect_any", "forbid", "first",
  "none", "note", "repeat", "threshold", "agents", "id",
] as const;
const SUITE_KEYS = ["agent", "model", "repeat", "threshold", "cases"] as const;

const DEFAULTS = { agent: "claude", repeat: 1, threshold: 1.0 };

export const BUILTIN_SKILLS = [
  "code-review", "simplify", "security-review", "init", "loop", "schedule",
  "update-config", "keybindings-help", "fewer-permission-prompts",
  "claude-api", "run",
  // seen in the init event of a clean config dir, verified by hand
  "deep-research", "design", "design-sync", "dataviz", "verify", "debug",
  "batch", "doctor", "workflow-authoring", "run-skill-generator",
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isNonEmptyString);
}

/** Collect all problems, index-prefixed per case; throws one ConfigError at the end. */
export function parseSuite(data: unknown): Suite {
  const errors: string[] = [];
  const legacy = Array.isArray(data);
  let rawCases: unknown[] = [];
  const suite: Suite = { agent: DEFAULTS.agent, repeat: DEFAULTS.repeat, threshold: DEFAULTS.threshold, cases: [] };

  if (legacy) {
    rawCases = data;
    if (rawCases.length === 0) errors.push("no cases");
  } else if (isObject(data)) {
    for (const key of Object.keys(data)) {
      if (!(SUITE_KEYS as readonly string[]).includes(key)) errors.push(`unknown key "${key}"`);
    }
    if (typeof data.agent !== "undefined") {
      if (typeof data.agent === "string") suite.agent = data.agent;
      else errors.push("agent must be a string");
    }
    if (typeof data.model !== "undefined") {
      if (typeof data.model === "string") suite.model = data.model;
      else errors.push("model must be a string");
    }
    if (typeof data.repeat !== "undefined") {
      if (isPositiveInt(data.repeat)) suite.repeat = data.repeat;
      else errors.push("repeat must be an integer >= 1");
    }
    if (typeof data.threshold !== "undefined") {
      if (isThreshold(data.threshold)) suite.threshold = data.threshold;
      else errors.push("threshold must be a number with 0 < x <= 1");
    }
    if (typeof data.cases === "undefined") errors.push("cases is required");
    else if (!Array.isArray(data.cases) || data.cases.length === 0) errors.push("cases must be a non-empty array");
    else rawCases = data.cases;
  } else {
    throw new ConfigError(["cases file must be an array of cases or an object with a cases key"]);
  }

  const seenIds = new Set<string>();
  rawCases.forEach((raw, i) => {
    const idx = i + 1;
    const c = validateCase(raw, idx, errors);
    if (!c) return;
    if (typeof c.id === "string") {
      if (seenIds.has(c.id)) errors.push(`#${idx}: duplicate id "${c.id}"`);
      seenIds.add(c.id);
    }
    suite.cases.push(c);
  });

  if (errors.length > 0) throw new ConfigError(errors);
  return suite;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function isThreshold(v: unknown): v is number {
  return typeof v === "number" && v > 0 && v <= 1;
}

function validateCase(raw: unknown, idx: number, errors: string[]): Case | null {
  if (!isObject(raw)) {
    errors.push(`#${idx}: case must be an object`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!(CASE_KEYS as readonly string[]).includes(key)) errors.push(`#${idx}: unknown key "${key}"`);
  }
  const c: Case = {
    index: idx, query: "", expect: [], expect_any: [], forbid: [], none: false,
  };
  let bad = false;
  const fail = (msg: string) => { errors.push(`#${idx}: ${msg}`); bad = true; };

  if (typeof raw.query === "undefined") fail("query is required");
  else if (!isNonEmptyString(raw.query)) fail("query must be a non-empty string");
  else c.query = raw.query;

  for (const key of ["expect", "expect_any", "forbid", "agents"] as const) {
    const v = raw[key];
    if (typeof v === "undefined") continue;
    if (!isStringArray(v)) { fail(`${key} must be an array of non-empty strings`); continue; }
    c[key] = [...v];
  }
  for (const key of ["first", "note", "id"] as const) {
    const v = raw[key];
    if (typeof v === "undefined") continue;
    if (typeof v !== "string" || (key === "first" && v.length === 0)) { fail(`${key} must be a string`); continue; }
    c[key] = v;
  }
  if (typeof raw.none !== "undefined") {
    if (typeof raw.none !== "boolean") fail("none must be a boolean");
    else c.none = raw.none;
  }
  if (typeof raw.repeat !== "undefined") {
    if (isPositiveInt(raw.repeat)) c.repeat = raw.repeat;
    else fail("repeat must be an integer >= 1");
  }
  if (typeof raw.threshold !== "undefined") {
    if (isThreshold(raw.threshold)) c.threshold = raw.threshold;
    else fail("threshold must be a number with 0 < x <= 1");
  }

  const hasExpect = c.expect.length > 0;
  const hasAny = c.expect_any.length > 0;
  const hasForbid = c.forbid.length > 0;
  if (!hasExpect && !hasAny && !hasForbid && !c.first && !c.none) {
    fail("at least one of expect, expect_any, forbid, first, none is required");
  }
  if (c.none && (hasExpect || hasAny || c.first)) {
    fail('none: true contradicts expect/expect_any/first');
  }
  const wanted = new Set([...c.expect, ...c.expect_any, ...(c.first ? [c.first] : [])]);
  for (const name of c.forbid) {
    if (wanted.has(name)) fail(`"${name}" is both expected and forbidden`);
  }
  return bad ? null : c;
}

/** Read a cases file (.json / .yaml / .yml) and parse it. */
export async function loadSuite(filePath: string): Promise<Suite> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    throw new ConfigError([`cannot read ${filePath}: ${(e as Error).message}`]);
  }
  const ext = path.extname(filePath).toLowerCase();
  let data: unknown;
  try {
    if (ext === ".json") data = JSON.parse(text);
    else if (ext === ".yaml" || ext === ".yml") data = parseYaml(text);
    else throw new ConfigError([`unsupported file format "${ext || filePath}": use .json, .yaml or .yml`]);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError([`cannot parse ${filePath}: ${(e as Error).message}`]);
  }
  return parseSuite(data);
}

export function findDefaultCasesFile(cwd: string): string | undefined {
  for (const name of ["skillcheck.yaml", "skillcheck.yml", "skillcheck.json"]) {
    const p = path.join(cwd, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // missing, keep looking
    }
  }
  return undefined;
}

/** Names of skills/commands discoverable on disk, plus built-in slash skills. */
export function knownSkillNames(opts?: { home?: string; cwd?: string; configDir?: string; pluginDirs?: string[] }): Set<string> {
  const out = new Set<string>(BUILTIN_SKILLS);
  for (const root of skillRoots(opts)) {
    for (const name of skillDirNames(path.join(root, "skills"))) out.add(name);
    for (const name of commandNames(path.join(root, "commands"))) out.add(name);
  }
  for (const doc of loadSkillDocs(opts)) if (doc.plugin !== null) out.add(doc.name);
  return out;
}

const NAME_FIELDS = ["expect", "expect_any", "forbid", "first"] as const;

export function unknownNames(suite: Suite, known: Set<string>, sourcePlugins: Set<string> = new Set()): string[] {
  const errors: string[] = [];
  for (const c of suite.cases) {
    for (const field of NAME_FIELDS) {
      const names = field === "first" ? (c.first ? [c.first] : []) : c[field];
      for (const name of names) {
        if (name.includes(":") && !sourcePlugins.has(name.slice(0, name.indexOf(":")))) continue; // installed plugin skills are not checked
        if (!known.has(name)) errors.push(`#${c.index}: unknown skill "${name}" in ${field}`);
      }
    }
  }
  return errors;
}
