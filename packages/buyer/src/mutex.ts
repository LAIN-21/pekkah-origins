/**
 * One payment in flight per buyer wallet (PLAN 4.5). A holder can keep the lock after its own
 * work returns, e.g. until Blockfrost shows the settled transaction, so the next payment never
 * spends inputs the chain hasn't seen yet.
 */
export class PaymentMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: (hold: (until: Promise<unknown>) => void) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holds: Promise<unknown>[] = [];
    const hold = (until: Promise<unknown>) => void holds.push(until);
    return previous.then(async () => {
      try {
        return await work(hold);
      } finally {
        void Promise.allSettled(holds).then(() => release());
      }
    });
  }

  /** Resolves once every queued payment and every hold has finished. */
  async idle(): Promise<void> {
    let seen: Promise<void> | undefined;
    while (seen !== this.tail) {
      seen = this.tail;
      await seen;
    }
  }
}
