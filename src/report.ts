import type { Case } from "./cases.js";
import type { ConfusionPair } from "./confusion.js";
import type { CaseResult } from "./judge.js";
import { DIAGNOSIS_LIMIT } from "./judge.js";

export type ReportStream = NodeJS.WritableStream & { isTTY?: boolean };

const RESET = "\u001b[0m";
const MARK_WIDTH = 6; // "ok" / "FAIL" padded, keeps the columns aligned
const QUERY_WIDTH = 48;

/** One line per finished case plus a summary; plain text when not a TTY. */
export class Reporter {
  private readonly useColor: boolean;

  constructor(private readonly out: ReportStream) {
    this.useColor = out.isTTY === true && !process.env.NO_COLOR;
  }

  header(nCases: number, repeat: number, nAgents: number, totalRuns?: number): void {
    const runs = totalRuns ?? nCases * repeat * nAgents;
    const agents = nAgents === 1 ? "agent" : "agents";
    this.write(`${nCases} cases × ${repeat} repeat × ${nAgents} ${agents} = ${runs} runs\n`);
  }

  batchHeader(nCases: number, repeat: number, calls: number): void {
    this.write(`${nCases} cases × ${repeat} repeat, batch mode = ${calls} call${calls === 1 ? "" : "s"}\n`);
  }

  /** A dim advisory line under the summary. */
  note(text: string): void {
    this.write(this.paint("2", text) + "\n");
  }

  caseDone(res: CaseResult): void {
    const label = `#${res.case.id ?? res.case.index}`;
    const mark = res.ok ? this.paint("32", "ok".padEnd(MARK_WIDTH)) : this.paint("31", "FAIL".padEnd(MARK_WIDTH));
    const runs = res.runs.length;
    const score = runs > 1 ? ` ${res.passed}/${runs}` : "";
    const loaded = [...new Set(res.runs.flatMap((r) => r.loaded))];
    const failed = res.runs.find((r) => !r.ok);
    const reason = !res.ok && failed ? ` · ${failed.reason}` : "";
    const arrow = this.paint("2", "→");
    this.write(`${mark}${label}  ${oneLine(res.case.query)}${score}  ${arrow} ${loaded.length > 0 ? loaded.join(", ") : this.paint("2", "—")}${reason}\n`);

    const diagnosed = res.runs.find((r) => r.diagnosis);
    if (diagnosed?.diagnosis) {
      this.write(`      ${this.paint("33", `diagnosis ${label}: ${diagnosed.diagnosis}`)}\n`);
    }
  }

  /** A case the budget never let start; printed after all real runs settle. */
  caseSkipped(c: Case): void {
    const label = `#${c.id ?? c.index}`;
    const mark = this.paint("33", "skip".padEnd(MARK_WIDTH));
    const arrow = this.paint("2", "→");
    this.write(`${mark}${label}  ${oneLine(c.query)}  ${arrow} budget reached\n`);
  }

  summary(
    results: CaseResult[],
    extra?: {
      unavailable?: string[];
      confusion?: ConfusionPair[];
      skipped?: number;
      budget?: { limitUsd: number; spent: number; notStartedRuns: number };
      /** spend with runs that reported no cost estimated from tokens */
      estimatedUsd?: number;
    },
  ): void {
    const verdicts = results.flatMap((r) => r.runs);
    this.write("\n");

    const diagnoses = verdicts.filter((v) => v.diagnosis).length;
    if (diagnoses >= 2) this.write(this.paint("33", `warning: ${diagnoses} diagnoses. ${DIAGNOSIS_LIMIT}`) + "\n");
    const unavailable = extra?.unavailable ?? [];
    if (unavailable.length > 0) {
      this.write(this.paint("33", `warning: expected skills not available to the agent: ${unavailable.join(", ")}`) + "\n");
    }

    const pairs = extra?.confusion ?? [];
    if (pairs.length > 0) {
      this.write("confusion:\n");
      for (const p of pairs) this.write(`  expected ${p.expected} → got ${p.got} (${p.count})\n`);
    }
    if (extra?.budget) {
      const b = extra.budget;
      const text = `budget $${b.limitUsd.toFixed(2)} reached (spent ~$${b.spent.toFixed(2)}), ${b.notStartedRuns} runs not started`;
      this.write(this.paint("33", text) + "\n");
    }

    const failed = results.filter((r) => !r.ok).length;
    const skipped = extra?.skipped ?? 0;
    const skippedPart = skipped > 0 ? `, ${skipped} skipped` : "";
    this.write(`${failed} failed${skippedPart} of ${results.length + skipped} · runs ${verdicts.length} · ${costLine(verdicts.map((v) => v.costUsd), extra?.estimatedUsd)}\n`);
  }

  private paint(code: string, text: string): string {
    return this.useColor ? `\u001b[${code}m${text}${RESET}` : text;
  }

  private write(text: string): void {
    this.out.write(text);
  }
}

function costLine(costs: (number | null)[], estimated?: number): string {
  const known = costs.filter((c): c is number => c !== null);
  const sum = known.reduce((a, b) => a + b, 0);
  const unknown = costs.length - known.length;
  if (unknown > 0 && estimated !== undefined && estimated > sum) {
    return `cost ~$${estimated.toFixed(2)} (${unknown} runs estimated from tokens)`;
  }
  if (known.length === 0) return "cost ?";
  const tail = unknown > 0 ? ` (+? for ${unknown} runs)` : "";
  return `cost $${sum.toFixed(2)}${tail}`;
}

/** Collapse to one line and truncate; long queries must not wrap the table. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > QUERY_WIDTH ? `${flat.slice(0, QUERY_WIDTH)}…` : flat;
}
