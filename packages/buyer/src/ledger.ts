// Spend caps (PLAN 2, Agent caps). A payment counts the moment it is signed and is never
// refunded here: a cancelled payment is not charged, but its signed transaction stays valid
// until its TTL, so counting it keeps the caps on the safe side.

export interface SpendCaps {
  perPayment: bigint;
  perRun: bigint;
  perDay: bigint;
}

export class SpendLedger {
  private readonly runs = new Map<string, bigint>();
  private readonly days = new Map<string, bigint>();

  constructor(
    private readonly caps: SpendCaps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private day(): string {
    return this.now().toISOString().slice(0, 10);
  }

  spent(runId: string): { run: bigint; day: bigint } {
    return { run: this.runs.get(runId) ?? 0n, day: this.days.get(this.day()) ?? 0n };
  }

  /** The reason this payment would break a cap, or null. */
  check(runId: string, amountAtomic: string): string | null {
    const amount = BigInt(amountAtomic);
    const { run, day } = this.spent(runId);
    if (amount > this.caps.perPayment) {
      return `amount ${amount} is over the per-payment cap ${this.caps.perPayment}`;
    }
    if (run + amount > this.caps.perRun) {
      return `run total ${run + amount} would pass the per-run cap ${this.caps.perRun}`;
    }
    if (day + amount > this.caps.perDay) {
      return `day total ${day + amount} would pass the per-day cap ${this.caps.perDay}`;
    }
    return null;
  }

  record(runId: string, amountAtomic: string): void {
    const amount = BigInt(amountAtomic);
    const day = this.day();
    this.runs.set(runId, (this.runs.get(runId) ?? 0n) + amount);
    this.days.set(day, (this.days.get(day) ?? 0n) + amount);
  }
}
