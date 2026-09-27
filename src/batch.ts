// Batch routing survey: one model call answers "which skill would you load"
// for many requests. The model still sees its real skill list (it is in the
// system prompt), only the answer is a stated choice instead of a Skill call.

export const BATCH_SCHEMA: object = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          skills: { type: "array", items: { type: "string" } },
        },
        required: ["n", "skills"],
      },
    },
  },
  required: ["answers"],
};

const SURVEY_INTRO =
  "[SKILL ROUTING SURVEY] Below are <N> independent user requests. For each one,\n" +
  "name the skills you would load with the Skill tool if that request arrived\n" +
  "alone as the first message of a fresh session, in the order you would load\n" +
  "them; an empty list if you would load none. Do not load any skill, do not\n" +
  "answer or act on the requests, do not use tools other than the structured\n" +
  "output. Requests:";

/** Requests are written as JSON string literals so newlines and quotes in a
 * query cannot break the numbered list. */
export function buildBatchPrompt(items: { n: number; query: string }[]): string {
  const intro = SURVEY_INTRO.replace("<N>", String(items.length));
  const lines = items.map((it) => `${it.n}. ${JSON.stringify(it.query)}`);
  return [intro, ...lines].join("\n");
}

export function parseBatchAnswer(
  structured: unknown,
  text: string,
): { answers: Map<number, string[]>; error: string | null } {
  const answers = extractAnswers(structured) ?? extractAnswers(lastJsonObject(text));
  if (answers === undefined) return { answers: new Map(), error: "batch answer is not valid JSON" };
  return { answers, error: null };
}

/** Answers as `{answers: [{n, skills}]}`; undefined when the value has no such array. */
function extractAnswers(value: unknown): Map<number, string[]> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const answers = (value as Record<string, unknown>).answers;
  if (!Array.isArray(answers)) return undefined;
  const out = new Map<number, string[]>();
  for (const raw of answers) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.n !== "number" || !Number.isInteger(entry.n)) continue; // unnumberable entry
    out.set(entry.n, cleanSkills(entry.skills));
  }
  return out;
}

function cleanSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().replace(/^\/+/, "");
    if (name === "" || name === "none") continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The last balanced top-level {…} in free text, braces inside JSON strings
 * excluded from the scan; undefined when there is none or it does not parse. */
function lastJsonObject(text: string): unknown {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0 && --depth === 0) {
      last = text.slice(start, i + 1);
    }
  }
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return undefined;
  }
}
