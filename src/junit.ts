import type { CaseReport, SuiteReport } from "./results.js";

/** Codepoints that are not representable in XML 1.0 at all. */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * JUnit XML as GitLab and GitHub test reporters understand it. A run that
 * errored is an <error> (the model never answered), a wrong routing is a
 * <failure>.
 */
export function toJunit(report: SuiteReport): string {
  const suiteName = `skillcheck.${report.agent}`;
  const rows = report.cases.map((c) => ({ c, kind: classify(c) }));
  const count = (kind: Kind) => rows.filter((r) => r.kind === kind).length;
  const totals = `tests="${report.cases.length}" failures="${count("failed")}" errors="${count("errored")}"`;

  const properties = ["    <properties>", `      <property name="agent" value="${esc(report.agent)}"/>`];
  if (report.model !== null) properties.push(`      <property name="model" value="${esc(report.model)}"/>`);
  properties.push(`      <property name="costUsd" value="${report.summary.costUsd.toFixed(2)}"/>`);
  // a run killed before its result event reports no cost, so costUsd alone understates the spend
  if (report.summary.unknownCostRuns > 0) {
    properties.push(`      <property name="unknownCostRuns" value="${report.summary.unknownCostRuns}"/>`);
    properties.push(`      <property name="estimatedCostUsd" value="${report.summary.estimatedCostUsd.toFixed(2)}"/>`);
  }
  properties.push("    </properties>");

  const cases = rows.map(({ c, kind }) => testcase(c, kind, suiteName));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    // Jenkins' schema allows `skipped` on <testsuite> only, not on <testsuites>
    `<testsuites name="skillcheck" ${totals} time="${sec(report.durationMs)}">`,
    `  <testsuite name="${esc(suiteName)}" ${totals} skipped="${count("skipped")}" time="${sec(report.durationMs)}" timestamp="${esc(report.startedAt)}">`,
    ...properties,
    ...cases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

type Kind = "passed" | "failed" | "errored" | "skipped";

function classify(c: CaseReport): Kind {
  if (c.status !== "failed") return c.status === "skipped" ? "skipped" : "passed";
  const failed = c.runs.filter((r) => !r.ok);
  return failed.length > 0 && failed.every((r) => r.error) ? "errored" : "failed";
}

function testcase(c: CaseReport, kind: Kind, suiteName: string): string {
  const time = sec(c.runs.reduce((ms, r) => ms + r.durationMs, 0));
  const name = `#${c.id ?? c.index} ${collapse(c.query)}`;
  const open = `      <testcase name="${esc(name)}" classname="${esc(suiteName)}" time="${time}">`;
  if (kind === "passed") return `      <testcase name="${esc(name)}" classname="${esc(suiteName)}" time="${time}"/>`;
  if (kind === "skipped") return `${open}\n        <skipped message="budget reached"/>\n      </testcase>`;
  const error = kind === "errored";
  const culprit = c.runs.find((r) => !r.ok && (error ? r.error : !r.error));
  const tag = error ? "error" : "failure";
  const type = error ? "run" : "routing";
  const message = error ? culprit?.error ?? "" : culprit?.reason ?? "";
  return `${open}\n        <${tag} message="${esc(message)}" type="${type}">${esc(detail(c))}</${tag}>\n      </testcase>`;
}

/** One line per run, then the diagnoses, then the case note. */
function detail(c: CaseReport): string {
  const lines = c.runs.map((r, i) => {
    const head = `run ${i + 1}: ${r.ok ? "ok" : "FAIL"} loaded [${r.loaded.join(", ")}]`;
    return r.ok ? head : `${head} · ${r.reason}`;
  });
  const diagnoses = [...new Set(c.runs.map((r) => r.diagnosis).filter((d): d is string => d !== null))];
  lines.push(...diagnoses.map((d) => `diagnosis: ${d}`));
  if (c.note !== null) lines.push(`note: ${c.note}`);
  return lines.join("\n");
}

/** Milliseconds to seconds, at most three decimals, trailing zeros trimmed. */
function sec(ms: number): string {
  return String(Number((ms / 1000).toFixed(3)));
}

/** Collapse to one line without truncating; the full query must stay in the name. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function esc(text: string): string {
  return text
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
