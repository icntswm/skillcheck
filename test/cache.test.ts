import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { caseFingerprint, mergeCache, nestedCommandFiles, parseCache, routingContext, type CacheEntry } from "../src/cache.js";
import type { Case } from "../src/cases.js";

const base: Case = {
  index: 1, id: "one", query: "find the bug", expect: ["debug"], expect_any: [], forbid: [],
  first: undefined, none: false, note: "comment",
};
const settings = {
  repeat: 1, threshold: 1, agent: "claude", model: "sonnet", batch: false,
  directive: "stop", earlyStop: true, agentVersion: "1.0",
};
const docs = [
  { name: "z", kind: "skill" as const, file: "z", description: "z", plugin: null },
  { name: "a", kind: "command" as const, file: "a", description: "a", plugin: "plug" },
];
const read = (file: string) => file === "z" ? "---\ndescription: z\n---\nbody" : "---\ndescription: a\n---\nbody";

describe("result cache", () => {
  it("fingerprints routing inputs but not ids, notes, bodies or doc order", () => {
    const context = routingContext(docs, read);
    const same = { ...base, index: 9, id: "renamed", note: "new comment" };
    expect(caseFingerprint(base, settings, context)).toBe(caseFingerprint(same, settings, routingContext([...docs].reverse(), read)));
    expect(caseFingerprint({ ...base, query: "other" }, settings, context)).not.toBe(caseFingerprint(base, settings, context));
    expect(caseFingerprint(base, { ...settings, repeat: 2 }, context)).not.toBe(caseFingerprint(base, settings, context));
    expect(caseFingerprint(base, { ...settings, threshold: 0.5 }, context)).not.toBe(caseFingerprint(base, settings, context));
    expect(caseFingerprint(base, { ...settings, model: "opus" }, context)).not.toBe(caseFingerprint(base, settings, context));
    expect(caseFingerprint(base, { ...settings, batch: true }, context)).not.toBe(caseFingerprint(base, settings, context));
    expect(caseFingerprint(base, { ...settings, directive: "other" }, context)).not.toBe(caseFingerprint(base, settings, context));
    expect(caseFingerprint(base, { ...settings, agentVersion: "2.0" }, context)).not.toBe(caseFingerprint(base, settings, context));
    expect(caseFingerprint(base, settings, context.replace("body", "changed"))).toBe(caseFingerprint(base, settings, context));
    expect(caseFingerprint(base, settings, context.replace("description: z", "description: changed"))).not.toBe(caseFingerprint(base, settings, context));
  });

  it("rejects malformed cache files and merges only current entries", () => {
    expect(() => parseCache("nope")).toThrow("invalid JSON");
    expect(() => parseCache(JSON.stringify({ tool: "other", version: "1", entries: [] }))).toThrow("wrong tool");
    const report = { index: 1, id: null, query: "q", note: null, expect: [], expect_any: [], forbid: [], first: null, none: true, status: "passed" as const, passed: 1, threshold: 1, runs: [], change: null };
    const old: CacheEntry = { fingerprint: "old", case: report };
    const fresh: CacheEntry = { fingerprint: "fresh", case: { ...report, query: "new" } };
    expect(mergeCache({ tool: "skillcheck-cache", version: "1", entries: [old] }, [fresh], new Set(["old", "fresh"]), "2").entries).toEqual([old, fresh]);
    expect(mergeCache(null, [fresh], new Set(), "2").entries).toEqual([fresh]);
    const validRun = { ok: true, reasons: [], reason: "", loaded: [], diagnosis: null, costUsd: null, error: null, stoppedEarly: false, durationMs: 1 };
    const valid = { tool: "skillcheck-cache", version: "1", entries: [{ fingerprint: "x", case: { ...report, runs: [validRun], passed: 1 } }] };
    expect(() => parseCache(JSON.stringify({ ...valid, entries: [{ ...valid.entries[0]!, case: { ...valid.entries[0]!.case, runs: [null] } }] }))).toThrow("entries have the wrong shape");
    expect(() => parseCache(JSON.stringify({ ...valid, entries: [{ ...valid.entries[0]!, case: { ...valid.entries[0]!.case, runs: [], passed: 1 } }] }))).toThrow("entries have the wrong shape");
  });

  it("includes nested command frontmatter but not body in routing context", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skillcheck-cache-"));
    try {
      const file = path.join(root, "commands", "team", "review.md");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "---\ndescription: review one\n---\nbody one\n");
      expect(nestedCommandFiles([root])).toEqual([file]);
      const read = (name: string) => readFileSync(name, "utf8");
      const first = routingContext([], read, [root]);
      writeFileSync(file, "---\ndescription: review one\n---\nbody two\n");
      expect(routingContext([], read, [root])).toBe(first);
      writeFileSync(file, "---\ndescription: review two\n---\nbody two\n");
      expect(routingContext([], read, [root])).not.toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
