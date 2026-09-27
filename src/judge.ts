import type { Case } from "./cases.js";
import type { RunResult } from "./agents/types.js";

export const DIAGNOSIS =
  "skill named in text but not invoked — a model or directive limit, not routing";
export const DIAGNOSIS_LIMIT = "reproduce on a stronger model before editing descriptions";

export interface RunVerdict {
  ok: boolean;
  reasons: string[];
  /** first two reasons, "; " separated; "" when ok */
  reason: string;
  loaded: string[];
  diagnosis: string | null;
  costUsd: number | null;
  error: string | null;
  stoppedEarly: boolean;
  durationMs: number;
}

export function judge(c: Case, r: RunResult): RunVerdict {
  if (r.error) {
    return {
      ok: false, reasons: [r.error], reason: r.error, loaded: r.loaded,
      diagnosis: null, costUsd: r.costUsd, error: r.error,
      stoppedEarly: r.stoppedEarly, durationMs: r.durationMs,
    };
  }
  const got = r.loaded;
  const reasons: string[] = [];

  for (const name of c.expect) {
    if (!got.includes(name)) reasons.push(`not loaded ${name}`);
  }
  if (c.expect_any.length > 0 && !c.expect_any.some((name) => got.includes(name))) {
    reasons.push(`not loaded any of [${c.expect_any.join(", ")}]`);
  }
  for (const name of c.forbid) {
    if (got.includes(name)) reasons.push(`forbidden ${name}`);
  }
  if (c.first) {
    if (got.length === 0) reasons.push(`nothing loaded, expected ${c.first} first`);
    else if (got[0] !== c.first) reasons.push(`loaded ${got[0]} first, expected ${c.first}`);
  }
  if (c.none && got.length > 0) {
    reasons.push(`expected nothing, loaded [${got.join(", ")}]`);
  }

  const unique = [...new Set(reasons)];
  const ok = unique.length === 0;
  let diagnosis: string | null = null;
  if (!ok && got.length === 0) {
    const text = r.text.toLowerCase();
    const named = [...c.expect, ...c.expect_any].some((name) => text.includes(name.toLowerCase()));
    if (named) diagnosis = DIAGNOSIS;
  }
  return {
    ok, reasons: unique, reason: unique.slice(0, 2).join("; "), loaded: got,
    diagnosis, costUsd: r.costUsd, error: null,
    stoppedEarly: r.stoppedEarly, durationMs: r.durationMs,
  };
}

export interface CaseResult {
  case: Case;
  runs: RunVerdict[];
  passed: number;
  ok: boolean;
  threshold: number;
}

export function aggregate(c: Case, runs: RunVerdict[], threshold: number): CaseResult {
  const passed = runs.filter((r) => r.ok).length;
  // epsilon: 1/3 * 3 >= 1.0 must hold despite float noise
  const ok = runs.length > 0 && passed / runs.length >= threshold - 1e-9;
  return { case: c, runs, passed, ok, threshold };
}
