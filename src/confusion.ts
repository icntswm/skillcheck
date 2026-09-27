import type { Case } from "./cases.js";
import type { CaseResult } from "./judge.js";

export interface ConfusionPair { expected: string; got: string; count: number }

/**
 * Confusion pairs over failed routing runs: which expected skill was missed
 * and what the agent loaded instead. Error runs are skipped (they say nothing
 * about routing); so are runs whose only failures concern forbid/none, since
 * the expected-label rules below produce no label for them.
 */
export function confusion(results: CaseResult[]): ConfusionPair[] {
  const counts = new Map<string, ConfusionPair>();
  for (const res of results) {
    for (const run of res.runs) {
      if (run.ok || run.error) continue;
      for (const expected of expectedLabels(res.case, run.loaded)) {
        for (const got of gotLabels(res.case, run.loaded)) {
          const key = `${expected}\u0000${got}`;
          const pair = counts.get(key);
          if (pair) pair.count++;
          else counts.set(key, { expected, got, count: 1 });
        }
      }
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.expected.localeCompare(b.expected) || a.got.localeCompare(b.got),
  );
}

/** A missed expectation; expect_any collapses to one "a|b" label. */
function expectedLabels(c: Case, loaded: string[]): string[] {
  const labels: string[] = [];
  for (const name of c.expect) if (!loaded.includes(name)) labels.push(name);
  if (c.expect_any.length > 0 && !c.expect_any.some((name) => loaded.includes(name))) {
    labels.push(c.expect_any.join("|"));
  }
  if (c.first && loaded[0] !== c.first && !labels.includes(c.first)) labels.push(c.first);
  return labels;
}

/** Loaded skills nobody asked for; "(nothing)" when the agent loaded none. */
function gotLabels(c: Case, loaded: string[]): string[] {
  const allowed = new Set([...c.expect, ...c.expect_any, ...(c.first ? [c.first] : [])]);
  const unexpected = loaded.filter((name) => !allowed.has(name));
  return unexpected.length > 0 ? unexpected : ["(nothing)"];
}
