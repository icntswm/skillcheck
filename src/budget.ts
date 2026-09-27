import type { TokenUsage } from "./agents/types.js";

/**
 * Tokens in input-token equivalents. Anthropic prices every model the same
 * way relative to its input price: output 5x, cache reads 0.1x, 5-minute
 * cache writes 1.25x, 1-hour cache writes 2x.
 */
export function inputEquivalent(u: TokenUsage): number {
  return u.input + 5 * u.output + 0.1 * u.cacheRead + 1.25 * u.cacheWrite5m + 2 * u.cacheWrite1h;
}

/**
 * USD per input token until a finished run shows the real rate. Rounded up
 * where unsure: the budget is a cap, so overestimating is the safe side.
 */
function listInputPrice(model: string | null): number {
  if (model?.includes("haiku")) return 1e-6;
  if (model?.includes("sonnet")) return 3e-6;
  return 5e-6;
}

/**
 * Running spend estimate for --budget. Runs killed by early-stop never report
 * a cost, so they are priced from their token usage: at the rate seen in
 * finished runs, or at list price before any run finishes. Runs with neither
 * cost nor usage count at the average known cost.
 */
export class Budget {
  private knownSum = 0;
  private knownCount = 0;
  private unknownCount = 0;
  private rateCost = 0;
  private rateTokens = 0;
  private unpriced: TokenUsage[] = [];

  constructor(private readonly limitUsd: number) {}

  add(cost: number | null, usage: TokenUsage | null = null): void {
    const tokens = usage ? inputEquivalent(usage) : 0;
    if (cost !== null) {
      this.knownSum += cost;
      this.knownCount++;
      if (tokens > 0) {
        this.rateCost += cost;
        this.rateTokens += tokens;
      }
    } else if (usage && tokens > 0) {
      this.unpriced.push(usage);
    } else {
      this.unknownCount++;
    }
  }

  get spent(): number {
    const avg = this.knownCount > 0 ? this.knownSum / this.knownCount : 0;
    const estimated = this.unpriced.reduce((sum, u) => {
      const rate = this.rateTokens > 0 ? this.rateCost / this.rateTokens : listInputPrice(u.model);
      return sum + inputEquivalent(u) * rate;
    }, 0);
    return this.knownSum + estimated + this.unknownCount * avg;
  }

  get exceeded(): boolean {
    return this.spent >= this.limitUsd;
  }
}
