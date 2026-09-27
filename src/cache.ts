import * as crypto from "node:crypto";
import * as fs from "node:fs";
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

export interface FingerprintSettings {
  repeat: number;
  threshold: number;
  agent: string;
  model: string | null;
  batch: boolean;
  directive: string;
  earlyStop: boolean;
  agentVersion: string | null;
}

export function routingContext(docs: SkillDoc[], readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): string {
  const sorted = [...docs].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || (a.plugin ?? "").localeCompare(b.plugin ?? ""));
  return JSON.stringify(sorted.map((doc) => ({
    kind: doc.kind,
    name: doc.name,
    plugin: doc.plugin,
    frontmatter: rawFrontmatter(readFile, doc.file),
  })));
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
    if (!isObject(entry) || typeof entry.fingerprint !== "string" || !isObject(entry.case)
      || entry.case.status !== "passed" || typeof entry.case.query !== "string"
      || !Array.isArray(entry.case.runs) || typeof entry.case.passed !== "number") {
      throw new Error("entries have the wrong shape");
    }
    entries.push({ fingerprint: entry.fingerprint, case: entry.case as unknown as CaseReport });
  }
  return { tool: "skillcheck-cache", version: value.version, entries };
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
