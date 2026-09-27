import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget.js";

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
});
