/**
 * Running spend estimate for --budget. Runs killed by early-stop never report
 * a cost, so unknown costs are estimated at the average known cost (0 until
 * the first known cost arrives); without this the budget could never trigger.
 */
export class Budget {
  private knownSum = 0;
  private knownCount = 0;
  private unknownCount = 0;

  constructor(private readonly limitUsd: number) {}

  add(cost: number | null): void {
    if (cost === null) this.unknownCount++;
    else {
      this.knownSum += cost;
      this.knownCount++;
    }
  }

  get spent(): number {
    const avg = this.knownCount > 0 ? this.knownSum / this.knownCount : 0;
    return this.knownSum + this.unknownCount * avg;
  }

  get exceeded(): boolean {
    return this.spent >= this.limitUsd;
  }
}
