import type { Case, Suite } from "./cases.js";
import type { SkillDoc } from "./describe.js";
import { LexicalIndex } from "./lexical.js";

export interface LintOptions {
  top: number;
  overlap: number;
  minLength: number;
}

export interface LintReport {
  docs: number;
  cases: number;
  short: { name: string; kind: string; length: number }[];
  similar: { a: string; b: string; score: number }[];
  far: { index: number; id: string | null; query: string; expected: string; rank: number; top: string[] }[];
  uncovered: string[];
}

// measured on a real config: a true near-duplicate pair scored 0.42, a known
// confusion pair 0.20, so 0.3 separates them
export const LINT_DEFAULTS: LintOptions = { top: 5, overlap: 0.3, minLength: 40 };

export function lint(docs: SkillDoc[], suite: Suite | null, opts: LintOptions): LintReport {
  const index = new LexicalIndex(docs.map((d) => ({ name: d.name, text: d.description })));

  const short = docs
    .filter((d) => d.description.length < opts.minLength)
    .map((d) => ({ name: d.name, kind: d.kind, length: d.description.length }));
  const similar = index.pairs(opts.overlap);

  const far: LintReport["far"] = [];
  const covered = new Set<string>();
  if (suite) {
    for (const c of suite.cases) {
      for (const name of [...c.expect, ...c.expect_any, ...c.forbid, ...(c.first ? [c.first] : [])]) covered.add(name);
      if (c.none) continue; // a none case expects nothing lexical
      far.push(...farForCase(c, index, opts.top));
    }
  }
  // with no suite there is no evidence either way, so uncovered stays empty;
  // plugin skills are someone else's, they are not required to have cases
  const uncovered = suite
    ? docs.filter((d) => d.kind === "skill" && d.plugin === null && !covered.has(d.name)).map((d) => d.name).sort()
    : [];

  return { docs: docs.length, cases: suite?.cases.length ?? 0, short, similar, far, uncovered };
}

function farForCase(c: Case, index: LexicalIndex, top: number): LintReport["far"] {
  const ranking = index.rank(c.query);
  const byName = new Map(ranking.map((r, i) => [r.name, i + 1] as const));
  const targets: { label: string; members: string[] }[] = c.expect.map((name) => ({ label: name, members: [name] }));
  // the whole expect_any is one target, ranked by its best member
  if (c.expect_any.length > 0) targets.push({ label: c.expect_any.join("|"), members: c.expect_any });
  if (c.first !== undefined && !c.expect.includes(c.first)) targets.push({ label: c.first, members: [c.first] });

  const out: LintReport["far"] = [];
  for (const t of targets) {
    // names without a doc (built-ins, typos) cannot be ranked; plugin `x:y`
    // names have docs once plugins are loaded and are ranked like any other
    const ranks = t.members.map((m) => byName.get(m)).filter((r): r is number => r !== undefined);
    if (ranks.length === 0) continue;
    const rank = Math.min(...ranks);
    if (rank > top) {
      out.push({ index: c.index, id: c.id ?? null, query: c.query, expected: t.label, rank, top: ranking.slice(0, 3).map((r) => r.name) });
    }
  }
  return out;
}
