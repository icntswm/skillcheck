import type { SkillDoc } from "./describe.js";
import type { ConfusionPair } from "./confusion.js";
import type { CaseReport, SuiteReport } from "./results.js";

export const SUGGEST_SCHEMA: object = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          skill: { type: "string" },
          description: { type: "string" },
          reason: { type: "string" },
        },
        required: ["skill", "description", "reason"],
      },
    },
  },
  required: ["suggestions"],
};

export interface SuggestTargetEvidence {
  confusion: ConfusionPair[];
  failing: { query: string; loaded: string[][] }[];
  keepWorking: string[];
}

export type SuggestEvidence = Map<string, SuggestTargetEvidence>;

export interface Suggestion {
  skill: string;
  description: string;
  reason: string;
}

function mentioned(item: CaseReport, target: string, includeForbid: boolean): boolean {
  const fields = [...item.expect, ...item.expect_any, ...(item.first ? [item.first] : []), ...(includeForbid ? item.forbid : [])];
  return fields.includes(target);
}

function names(pair: ConfusionPair): string[] {
  return [...pair.expected.split("|"), ...(pair.got === "(nothing)" ? [] : [pair.got])];
}

function shortQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Gather bounded, report-only evidence for each target description. */
export function suggestEvidence(report: Pick<SuiteReport, "confusion" | "cases">, targets: string[] | Set<string>): SuggestEvidence {
  const wanted = new Set(targets);
  const out = new Map<string, SuggestTargetEvidence>();
  for (const target of wanted) out.set(target, { confusion: [], failing: [], keepWorking: [] });
  for (const pair of report.confusion) {
    for (const target of names(pair)) {
      const evidence = out.get(target);
      if (evidence) evidence.confusion.push(pair);
    }
  }
  for (const item of report.cases) {
    for (const target of wanted) {
      const evidence = out.get(target)!;
      // errors and diagnosed runs (model limits, see judge) say nothing about descriptions
      const failedRuns = item.runs.filter((run) => !run.ok && !run.error && !run.diagnosis);
      // a target can fail a case by being expected, or by being loaded where a neighbour belonged
      const involved = mentioned(item, target, true) || failedRuns.some((run) => run.loaded.includes(target));
      // a case can pass its threshold and still have failed runs behind a confusion pair
      if (failedRuns.length > 0 && involved) {
        if (evidence.failing.length >= 8) continue;
        const loaded = [...new Set(failedRuns.map((run) => JSON.stringify(run.loaded)))].map((list) => JSON.parse(list) as string[]);
        evidence.failing.push({ query: shortQuery(item.query), loaded });
      } else if (item.status === "passed" && mentioned(item, target, false) && evidence.keepWorking.length < 5) {
        evidence.keepWorking.push(shortQuery(item.query));
      }
    }
  }
  return out;
}

/** Build the description-editing prompt for one model group. */
export function buildSuggestPrompt(targets: SkillDoc[], context: SkillDoc[], evidence: SuggestEvidence): string {
  const contextLines = context.map((doc) => `- ${doc.name}: ${JSON.stringify(doc.description.replace(/\s+/g, " ").slice(0, 300))}`);
  const targetLines = targets.flatMap((doc) => {
    const item = evidence.get(doc.name) ?? { confusion: [], failing: [], keepWorking: [] };
    const confusion = item.confusion.length > 0
      ? item.confusion.map((pair) => `${pair.expected} -> ${pair.got} (${pair.count})`).join(", ")
      : "none";
    const failing = item.failing.length > 0
      ? item.failing.map((entry) => `- ${JSON.stringify(entry.query)}; loaded: ${entry.loaded.map((list) => `[${list.join(", ")}]`).join(", ") || "[]"}`).join("\n")
      : "none";
    const keep = item.keepWorking.length > 0 ? item.keepWorking.map((query) => `- ${JSON.stringify(query)}`).join("\n") : "none";
    return [
      `Target ${doc.name}. Current description: ${JSON.stringify(doc.description)}`,
      `Confusion: ${confusion}`,
      `Failing queries:\n${failing}`,
      `Keep-working queries:\n${keep}`,
    ];
  });
  return [
    "This is a description-editing task. Do not load any skill, do not use tools other than the structured output.",
    "Context skills:",
    ...contextLines,
    ...targetLines,
    "Rewrite only descriptions that need it. Keep the language of the current description. Use at most 1024 characters. Say concretely when to use the skill, and when a neighbour it was confused with should be used instead, by name. Do not break the keep-working queries. Do not mention test cases or skillcheck.",
    "Return only the structured output.",
  ].join("\n");
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Validate one model answer, retaining the first usable suggestion per target. */
export function parseSuggestAnswer(structured: unknown, targets: SkillDoc[] | Map<string, SkillDoc>): { suggestions: Suggestion[]; dropped: number } {
  const docs = targets instanceof Map ? targets : new Map(targets.map((doc) => [doc.name, doc]));
  if (typeof structured !== "object" || structured === null || Array.isArray(structured)) return { suggestions: [], dropped: 0 };
  const raw = (structured as Record<string, unknown>).suggestions;
  if (!Array.isArray(raw)) return { suggestions: [], dropped: 0 };
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  let dropped = 0;
  for (const value of raw) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) { dropped++; continue; }
    const item = value as Record<string, unknown>;
    const skill = item.skill;
    const description = item.description;
    const reason = item.reason;
    const doc = typeof skill === "string" ? docs.get(skill) : undefined;
    if (!doc || typeof description !== "string" || normalise(description) === "" || description.trim().length > 1024 || seen.has(skill as string) || normalise(description) === normalise(doc.description)) {
      dropped++;
      continue;
    }
    seen.add(skill as string);
    suggestions.push({ skill: skill as string, description: description.trim(), reason: typeof reason === "string" ? reason.trim() : "" });
  }
  return { suggestions, dropped };
}
