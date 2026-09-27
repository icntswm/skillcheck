import type { CaseReport, SuiteReport } from "./results.js";

/** An HTML comment so GitHub renders the report body clean under it. */
export const MARKDOWN_MARKER = "<!-- skillcheck -->";

/** Failure-focused Markdown summary for PR comments and GitHub job summaries. */
export function toMarkdown(report: SuiteReport): string {
  const s = report.summary;
  const lines = [MARKDOWN_MARKER, header(report)];
  lines.push("");
  lines.push(metaLine(report));
  if (report.batch) {
    lines.push("");
    lines.push("> Batch mode: answers are the model's stated choice, not an actual Skill call. Confirm failures with a normal run.");
  }
  if (s.budgetReached && s.budgetUsd !== null) {
    lines.push("");
    lines.push(`> ⚠️ Budget $${s.budgetUsd.toFixed(2)} reached, remaining cases were skipped.`);
  }
  if (report.unavailable.length > 0) {
    lines.push("");
    lines.push(`> ⚠️ Expected skills not available to the agent: ${report.unavailable.join(", ")}`);
  }
  if (s.failed + s.skipped > 0) {
    lines.push("");
    lines.push("| | Case | Request | Loaded | Reason |");
    lines.push("|---|---|---|---|---|");
    for (const c of report.cases) {
      if (c.status === "passed") continue;
      lines.push(failedRow(c));
    }
  }
  const passed = report.cases.filter((c) => c.status === "passed");
  if (passed.length > 0) {
    lines.push("");
    lines.push(`<details><summary>Passed (${passed.length})</summary>`);
    lines.push("");
    lines.push("| Case | Request | Loaded |");
    lines.push("|---|---|---|");
    for (const c of passed) lines.push(passedRow(c));
    lines.push("");
    lines.push("</details>");
  }
  if (report.confusion.length > 0) {
    lines.push("");
    lines.push("**Confusion** — descriptions to rewrite:");
    lines.push("");
    for (const p of report.confusion) lines.push(`- expected \`${p.expected}\` → got \`${p.got}\` (${p.count})`);
  }
  return lines.join("\n") + "\n";
}

/** ✅ with the pass count alone, ❌ with failed and skipped counts. */
function header(report: SuiteReport): string {
  const s = report.summary;
  if (s.failed === 0 && s.skipped === 0) {
    return `### ✅ skillcheck: ${s.cases} passed`;
  }
  const failedPart = s.failed > 0 ? `${s.failed} failed` : null;
  const skippedPart = s.skipped > 0 ? `${s.skipped} skipped` : null;
  const parts = [failedPart, skippedPart].filter((p): p is string => p !== null).join(", ");
  return `### ❌ skillcheck: ${parts} of ${s.cases}`;
}

/** Model, batch flag, runs, cost and duration, " · " separated. */
function metaLine(report: SuiteReport): string {
  const s = report.summary;
  const parts: string[] = [];
  if (report.model !== null) parts.push(report.model);
  if (report.batch) parts.push("batch mode");
  parts.push(`${s.runs} run${s.runs === 1 ? "" : "s"}`);
  if (s.unknownCostRuns > 0 && s.estimatedCostUsd > s.costUsd) parts.push(`cost ~$${s.estimatedCostUsd.toFixed(2)}`);
  else parts.push(`cost $${s.costUsd.toFixed(2)}`);
  parts.push(duration(report.durationMs));
  return parts.join(" · ");
}

/** Below a minute in seconds, then minutes and seconds, seconds rounded down. */
function duration(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** ⏭️ for skipped, ⚠️ when every failed run errored, ❌ for the rest. */
function failedRow(c: CaseReport): string {
  const cells =
    c.status === "skipped"
      ? ["⏭️", caseLabel(c), oneLine(c.query), loaded(c), "budget reached"]
      : [failMark(c), caseLabel(c), oneLine(c.query), loaded(c), reasonCell(c)];
  return `| ${cells.map(esc).join(" | ")} |`;
}

/** ⚠️ when every non-ok run errored (the model never answered), ❌ otherwise. */
function failMark(c: CaseReport): "⚠️" | "❌" {
  const bad = c.runs.filter((r) => !r.ok);
  return bad.length > 0 && bad.every((r) => r.error !== null) ? "⚠️" : "❌";
}

/** The first non-ok run's reason, the pass share prefixed over several runs,
 * a diagnosis appended in italics, then the case note. */
function reasonCell(c: CaseReport): string {
  const bad = c.runs.filter((r) => !r.ok);
  const parts = c.runs.length > 1 ? [`${c.passed}/${c.runs.length}`, bad[0]?.reason ?? ""] : [bad[0]?.reason ?? ""];
  let text = parts.join(" · ");
  const diagnosis = bad.find((r) => r.diagnosis !== null)?.diagnosis;
  if (diagnosis) text += ` — _${diagnosis}_`;
  if (c.note !== null) text += ` · note: ${c.note}`;
  return text;
}

function passedRow(c: CaseReport): string {
  const score = c.runs.length > 1 ? ` (${c.passed}/${c.runs.length})` : "";
  const cells = [`${caseLabel(c)}${score}`, oneLine(c.query), loaded(c)];
  return `| ${cells.map(esc).join(" | ")} |`;
}

function caseLabel(c: CaseReport): string {
  return `#${c.id ?? c.index}`;
}

/** Unique loaded skills across runs, "—" when none. */
function loaded(c: CaseReport): string {
  const names = [...new Set(c.runs.flatMap((r) => r.loaded))];
  return names.length > 0 ? names.join(", ") : "—";
}

/** Collapse to one line, truncated to 80 chars with "…". */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/** Pipes so they cannot break the table, newlines as spaces, HTML inert. */
function esc(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .replace(/</g, "&lt;");
}
