import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../src/agents/types.js";
import { Budget } from "../src/budget.js";

function tokens(input: number, model: string | null = "claude-sonnet-5"): TokenUsage {
  return { model, input, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

describe("Budget", () => {
  it("sums known costs and ignores unknowns until an average exists", () => {
    const b = new Budget(10);
    b.add(0.05);
    b.add(0.025);
    b.add(null);
    expect(b.spent).toBeCloseTo(0.1125, 10); // 0.075 known + 1 unknown × avg(0.0375)
  });

  it("estimates unknown costs at the average known cost", () => {
    const b = new Budget(10);
    b.add(0.04);
    b.add(0.06); // avg 0.05
    b.add(null);
    b.add(null);
    expect(b.spent).toBeCloseTo(0.2, 10); // 0.10 + 2 × 0.05
  });

  it("estimates unknowns as 0 before any known cost arrives", () => {
    const b = new Budget(1);
    b.add(null);
    b.add(null);
    expect(b.spent).toBe(0);
    expect(b.exceeded).toBe(false);
  });

  it("exceeded triggers at the boundary (spent >= limit)", () => {
    const b = new Budget(0.5);
    b.add(0.25);
    expect(b.exceeded).toBe(false);
    b.add(0.25);
    expect(b.exceeded).toBe(true);
  });

  it("the estimate alone can cross the limit (early-stopped runs have no cost)", () => {
    const b = new Budget(0.3);
    b.add(0.1);
    b.add(null);
    b.add(null); // 0.10 + 2 × 0.10 = 0.30
    expect(b.exceeded).toBe(true);
  });

  it("an empty budget never trips on its own zero spend", () => {
    const b = new Budget(0.001);
    expect(b.exceeded).toBe(false);
    expect(b.spent).toBe(0);
  });

  it("prices killed runs by tokens at the rate of finished runs", () => {
    const b = new Budget(10);
    b.add(0.02, tokens(10_000)); // $2 per million input tokens
    b.add(null, tokens(50_000));
    expect(b.spent).toBeCloseTo(0.12, 10); // 0.02 + 50k × $2/M
  });

  it("uses list price before any run finishes, so early stops alone can trip it", () => {
    const b = new Budget(0.3);
    b.add(null, tokens(50_000)); // sonnet $3/M → 0.15
    expect(b.exceeded).toBe(false);
    b.add(null, tokens(50_000));
    expect(b.exceeded).toBe(true);
    expect(new Budget(1).spent).toBe(0);
    const unknown = new Budget(10);
    unknown.add(null, tokens(100_000, null)); // unknown model priced high: $5/M
    expect(unknown.spent).toBeCloseTo(0.5, 10);
  });

  it("counts output and cache tokens at their price ratios", () => {
    const b = new Budget(10);
    b.add(null, { model: "claude-haiku-4-5", input: 0, output: 1000, cacheRead: 10_000, cacheWrite5m: 800, cacheWrite1h: 500 });
    expect(b.spent).toBeCloseTo((5000 + 1000 + 1000 + 1000) * 1e-6, 10);
  });
});
