import { describe, expect, it } from "vitest";
import { runPool } from "../src/pool.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runPool", () => {
  it("returns results in input order", async () => {
    const delays = [30, 0, 15, 5];
    const res = await runPool(delays, 4, async (d, i) => {
      await sleep(d);
      return i;
    });
    expect(res).toEqual([0, 1, 2, 3]);
  });

  it("never exceeds the concurrency cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const res = await runPool(Array.from({ length: 7 }, (_, i) => i), 2, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return i * 2;
    });
    expect(res).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(maxInFlight).toBe(2);
  });

  it("passes the input index to the worker", async () => {
    const seen: number[] = [];
    await runPool(["a", "b"], 1, async (item, i) => {
      seen.push(i);
      return item;
    });
    expect(seen).toEqual([0, 1]);
  });

  it("rejects after in-flight tasks settle when a worker throws", async () => {
    let finished = 0;
    await expect(runPool([1, 2, 3, 4], 4, async (i) => {
      await sleep(i);
      if (i === 1) throw new Error("boom");
      finished++;
      return i;
    })).rejects.toThrow("boom");
    expect(finished).toBe(3); // the other three resolved normally
  });

  it("shouldStart stops new items; skipped slots stay undefined", async () => {
    let started = 0;
    const res = await runPool([0, 1, 2, 3, 4, 5], 1, async (i) => {
      started++;
      return i;
    }, { shouldStart: () => started < 2 });
    expect(started).toBe(2);
    expect(res).toEqual([0, 1, undefined, undefined, undefined, undefined]);
  });

  it("handles empty input", async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([]);
  });
});
