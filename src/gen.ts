import { parse as parseYaml } from "yaml";
import { parseSuite } from "./cases.js";
import type { SkillDoc } from "./describe.js";
import { yamlName } from "./import.js";

export const GEN_SCHEMA: object = {
  type: "object",
  properties: {
    cases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          query: { type: "string" },
          skill: { type: ["string", "null"] },
          avoid: { type: ["string", "null"] },
        },
        required: ["query", "skill", "avoid"],
      },
    },
  },
  required: ["cases"],
};

export interface GenCase {
  query: string;
  skill: string | null;
  avoid: string | null;
}

/** Order generated cases by their requested skills and convert one to a suite entry. */
export function orderCases(cases: GenCase[], skills: string[]): GenCase[] {
  const buckets = new Map(skills.map((skill) => [skill, [] as GenCase[]]));
  const rest: GenCase[] = [];
  for (const item of cases) {
    const target = item.avoid ?? item.skill;
    const bucket = target === null ? undefined : buckets.get(target);
    if (bucket) bucket.push(item);
    else rest.push(item);
  }
  return [...skills.flatMap((skill) => buckets.get(skill) ?? []), ...rest];
}

/** A near miss owned by a neighbour gets both: expect the neighbour, forbid the target. */
export function caseEntry(item: GenCase): { query: string; expect?: string[]; forbid?: string[] } {
  return {
    query: item.query,
    ...(item.skill !== null ? { expect: [item.skill] } : {}),
    ...(item.avoid !== null ? { forbid: [item.avoid] } : {}),
  };
}

/** Build the case-writing prompt from installed descriptions. */
export function buildGenPrompt(targets: SkillDoc[], context: SkillDoc[], perSkill: number): string {
  const contextLines = context.map((doc) => `- ${doc.name}: ${JSON.stringify(doc.description.replace(/\s+/g, " ").slice(0, 300))}`);
  const near = Math.ceil(perSkill / 2);
  const targetLines = targets.map((doc) =>
    `For ${doc.name}: write ${perSkill} positive requests and ${near} near misses. ` +
    `Positive requests have skill ${JSON.stringify(doc.name)} and avoid null. ` +
    `Near misses have avoid ${JSON.stringify(doc.name)}, and skill is another listed skill or null.`,
  );
  return [
    "This is a test-writing task. Do not load any skill, do not use tools other than the structured output.",
    "Context skills:",
    ...contextLines,
    "For each target skill, write realistic first messages a user would send. They should vary in wording and length, must not name the skill, and should be written in the language of the skill description.",
    ...targetLines,
    "Return only the structured output. Each request must be a JSON string.",
  ].join("\n");
}

// targets: the skills asked for; every case must load or avoid one of them
export function parseGenAnswer(structured: unknown, known: Set<string>, targets: Set<string> = known): { cases: GenCase[]; dropped: number } {
  if (typeof structured !== "object" || structured === null || Array.isArray(structured)) return { cases: [], dropped: 0 };
  const rawCases = (structured as Record<string, unknown>).cases;
  if (!Array.isArray(rawCases)) return { cases: [], dropped: 0 };
  const cases: GenCase[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of rawCases) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { dropped++; continue; }
    const item = raw as Record<string, unknown>;
    const query = item.query;
    const skill = item.skill === null ? null : item.skill;
    const avoid = item.avoid === null ? null : item.avoid;
    if (typeof query !== "string" || query.trim() === "" ||
      (skill !== null && (typeof skill !== "string" || !known.has(skill))) ||
      (avoid !== null && (typeof avoid !== "string" || !known.has(avoid))) ||
      (skill === null && avoid === null) || skill === avoid || seen.has(query) ||
      !((skill !== null && targets.has(skill as string)) || (avoid !== null && targets.has(avoid as string)))) {
      dropped++;
      continue;
    }
    seen.add(query);
    cases.push({ query, skill: skill as string | null, avoid: avoid as string | null });
  }
  return { cases, dropped };
}

export function genSuite(cases: GenCase[], meta: { model: string | null; skills: string[]; json?: boolean }): string {
  const ordered = orderCases(cases, meta.skills);
  if (meta.json) {
    // JSON has no comments: the review note lives only in the command output
    const data = { agent: "claude", repeat: 1, threshold: 1, cases: ordered.map(caseEntry) };
    parseSuite(data);
    return JSON.stringify(data, null, 2) + "\n";
  }
  const lines = [
    `# Draft cases written by skillcheck gen (model: ${meta.model ?? "default"}) for: ${meta.skills.join(", ")}.`,
    "# Review every case: the model guessed what should route where. Delete what is wrong,",
    "# keep what matches how people really ask, then `skillcheck run --batch`.",
    "agent: claude",
    "repeat: 1",
    "threshold: 1.0",
    "cases:",
  ];
  for (const item of ordered) {
    lines.push(`  - query: ${JSON.stringify(item.query)}`);
    if (item.skill !== null) lines.push(`    expect: [${yamlName(item.skill)}]`);
    if (item.avoid !== null) lines.push(`    forbid: [${yamlName(item.avoid)}]`);
  }
  const text = lines.join("\n") + "\n";
  parseSuite(parseYaml(text));
  return text;
}
