import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Case } from "./cases.js";
import type { SkillDoc } from "./describe.js";
import type { CaseReport } from "./results.js";

export interface CacheEntry {
  fingerprint: string;
  case: CaseReport;
}

export interface CacheFile {
  tool: "skillcheck-cache";
  version: string;
  entries: CacheEntry[];
}

/** Nested command files, excluding top-level commands. */
export function nestedCommandFiles(roots: string[]): string[] {
  return roots.flatMap((root) => walkCommandFiles(path.join(root, "commands"), false)).sort();
}

function walkCommandFiles(dir: string, nested: boolean): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file); // follows symlinks, like the top-level scanners
    } catch {
      continue;
    }
    if (stat.isDirectory()) files.push(...walkCommandFiles(file, true));
    else if (nested && entry.endsWith(".md") && stat.isFile()) files.push(file);
  }
  return files;
}

export interface FingerprintSettings {
  repeat: number;
  threshold: number;
  agent: string;
  model: string | null;
  batch: boolean;
  directive: string;
  earlyStop: boolean;
  agentVersion: string | null;
  timeoutSec: number;
}

/** A file or dir, named so the key does not depend on where it lives on disk. */
export interface LabeledPath {
  label: string;
  path: string;
}

/** CLAUDE.md files Claude Code reads: the user one, then cwd and every dir above it. */
export function memoryFiles(configRoot: string, cwd: string): LabeledPath[] {
  const out: LabeledPath[] = [{ label: "user/CLAUDE.md", path: path.join(configRoot, "CLAUDE.md") }];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const rel = path.relative(cwd, dir) || ".";
    for (const name of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]) {
      out.push({ label: path.join(rel, name), path: path.join(dir, name) });
    }
    if (path.dirname(dir) === dir) return out;
  }
}

/**
 * Skill and command frontmatter, nested command frontmatter, and the full text of the
 * memory files (CLAUDE.md), which Claude Code also reads before it picks a skill.
 */
export function routingContext(
  docs: SkillDoc[],
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
  roots: LabeledPath[] = [],
  memory: LabeledPath[] = [],
): string {
  const sorted = [...docs].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || (a.plugin ?? "").localeCompare(b.plugin ?? ""));
  const context: Record<string, unknown>[] = sorted.map((doc) => ({
    kind: doc.kind,
    name: doc.name,
    plugin: doc.plugin,
    frontmatter: rawFrontmatter(readFile, doc.file),
  }));
  for (const root of roots) {
    for (const file of nestedCommandFiles([root.path])) {
      context.push({
        kind: "command-file",
        file: `${root.label}:${path.relative(root.path, file)}`,
        frontmatter: rawFrontmatter(readFile, file),
      });
    }
  }
  for (const file of memory) {
    let text: string;
    try {
      text = readFile(file.path);
    } catch {
      continue; // missing memory file
    }
    context.push({ kind: "memory", file: file.label, text });
  }
  return JSON.stringify(context);
}

function rawFrontmatter(readFile: (file: string) => string, file: string): string {
  try {
    const lines = readFile(file).split("\n");
    if (lines[0]?.trim() !== "---") return "";
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    return end < 0 ? "" : lines.slice(1, end).join("\n");
  } catch {
    return "";
  }
}

export function caseFingerprint(c: Case, settings: FingerprintSettings, context: string): string {
  const value = {
    case: {
      query: c.query,
      expect: c.expect,
      expect_any: c.expect_any,
      forbid: c.forbid,
      first: c.first ?? null,
      none: c.none,
      repeat: settings.repeat,
      threshold: settings.threshold,
    },
    run: {
      agent: settings.agent,
      model: settings.model,
      batch: settings.batch,
      directive: settings.batch ? null : settings.directive,
      earlyStop: settings.batch ? null : settings.earlyStop,
      timeoutSec: settings.timeoutSec,
    },
    agentVersion: settings.agentVersion,
    context,
  };
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseCache(text: string): CacheFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid JSON");
  }
  if (!isObject(value) || value.tool !== "skillcheck-cache") throw new Error('wrong tool (expected "skillcheck-cache")');
  if (typeof value.version !== "string") throw new Error("version must be a string");
  if (!Array.isArray(value.entries)) throw new Error("entries must be an array");
  const entries: CacheEntry[] = [];
  for (const entry of value.entries) {
    const passed = isObject(entry) && isObject(entry.case) ? entry.case.passed : undefined;
    if (!isObject(entry) || typeof entry.fingerprint !== "string" || !isObject(entry.case)
      || entry.case.status !== "passed" || typeof entry.case.query !== "string"
      || !Array.isArray(entry.case.runs) || entry.case.runs.length === 0
      || !entry.case.runs.every(isValidRun)
      || !Number.isInteger(passed) || (passed as number) <= 0 || passed !== entry.case.runs.filter((run) => isObject(run) && run.ok === true).length) {
      throw new Error("entries have the wrong shape");
    }
    entries.push({ fingerprint: entry.fingerprint, case: entry.case as unknown as CaseReport });
  }
  return { tool: "skillcheck-cache", version: value.version, entries };
}

function isValidRun(value: unknown): boolean {
  if (!isObject(value)) return false;
  return typeof value.ok === "boolean"
    && Array.isArray(value.loaded) && value.loaded.every((item) => typeof item === "string")
    && typeof value.reason === "string"
    && Array.isArray(value.reasons) && value.reasons.every((item) => typeof item === "string")
    && (typeof value.costUsd === "number" || value.costUsd === null)
    && (typeof value.error === "string" || value.error === null)
    && typeof value.stoppedEarly === "boolean"
    && typeof value.durationMs === "number"
    && (typeof value.diagnosis === "string" || value.diagnosis === null);
}

export function mergeCache(old: CacheFile | null, fresh: CacheEntry[], keep: Set<string>, version: string): CacheFile {
  const byFingerprint = new Map<string, CacheEntry>();
  for (const entry of old?.entries ?? []) if (keep.has(entry.fingerprint) && entry.case.status === "passed") byFingerprint.set(entry.fingerprint, entry);
  for (const entry of fresh) byFingerprint.set(entry.fingerprint, entry);
  return { tool: "skillcheck-cache", version, entries: [...byFingerprint.values()] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
