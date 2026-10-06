import { explorerTxUrl, type JobEvent, type JobEventInput, type RunLog } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import type { ReleaseOutcome, ReleasePlan } from "./escrow-release.js";
import { waitForTx } from "./result-publish.js";

// PR-16: every escrow whose result was submitted is released after its unlock time, with no
// human step. The release pays the price to the seller and returns the buyer's collateral.

export interface PendingRelease {
  lockTxHash: string;
  /** The escrow output's index in the lock transaction, from escrow.locked. */
  outputIndex?: number;
  /** POSIX ms, from the lock's escrow.locked event. */
  unlockTime: number;
  runId?: string;
  jobId?: string;
}

/**
 * The releases saved runs still owe: an escrow.result_submitted with no escrow.released or
 * escrow.refunded for its lock. The unlock time comes from the same run's escrow.locked.
 */
export function pendingReleases(runs: RunLog[]): PendingRelease[] {
  const pending: PendingRelease[] = [];
  for (const run of runs) {
    const locks = new Map<string, { unlockTime: number; outputIndex?: number; jobId?: string }>();
    const closed = new Set<string>();
    for (const e of run.events) {
      if (e.dev) continue;
      if (e.type === "escrow.locked") {
        locks.set(e.data.txHash, {
          unlockTime: Number(e.data.unlockTime),
          ...(e.data.outputIndex !== undefined ? { outputIndex: e.data.outputIndex } : {}),
          ...(e.jobId ? { jobId: e.jobId } : {}),
        });
      }
      if (e.type === "escrow.released" || e.type === "escrow.refunded") {
        closed.add(e.data.lockTxHash);
      }
    }
    for (const e of run.events) {
      if (e.type !== "escrow.result_submitted" || e.dev || closed.has(e.data.lockTxHash)) continue;
      const lock = locks.get(e.data.lockTxHash);
      if (!lock) continue;
      const jobId = e.jobId ?? lock.jobId;
      pending.push({
        lockTxHash: e.data.lockTxHash,
        ...(lock.outputIndex !== undefined ? { outputIndex: lock.outputIndex } : {}),
        unlockTime: lock.unlockTime,
        runId: run.runId,
        ...(jobId ? { jobId } : {}),
      });
    }
  }
  return pending;
}

export interface ReleaseSchedulerOptions {
  release: (lock: { lockTxHash: string; outputIndex?: number }) => Promise<ReleaseOutcome>;
  /** Whether the facilitator sees the transaction on chain. */
  txFound: (txHash: string) => Promise<boolean>;
  emit: (event: JobEventInput) => void;
  log: Logger;
  now?: () => number;
  /** A release fires this long after the unlock time. */
  afterUnlockMs?: number;
  /** The earliest a release fires after it is scheduled, so a fresh market can settle first. */
  minDelayMs?: number;
  pollMs?: number;
  polls?: number;
  /** The wait before attempt `n + 1`. */
  backoffMs?: (attempt: number) => number;
  maxAttempts?: number;
}

interface Entry {
  p: PendingRelease;
  timer?: NodeJS.Timeout;
  attempts: number;
  firing: boolean;
}

const backoff = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 10 * 60_000);

/**
 * Fires each pending release at unlock + 60 s. The releaser checks that the escrow is still
 * open, then builds, evaluates, signs and submits the Withdraw. A failure that may pass (the
 * chain unreachable, the unlock not reached yet) is retried with backoff. The release counts
 * only once the chain shows it: then escrow.released goes to the lock's run.
 */
export class ReleaseScheduler {
  private readonly entries = new Map<string, Entry>();
  /** Unlock times from live escrow.locked events, for the result that follows. */
  private readonly locks = new Map<string, PendingRelease>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly o: ReleaseSchedulerOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Feeds live events: a lock gives the unlock time, its submitted result schedules it. */
  observe(event: JobEvent): void {
    if (event.dev) return;
    if (event.type === "escrow.locked") {
      this.locks.set(event.data.txHash, {
        lockTxHash: event.data.txHash,
        ...(event.data.outputIndex !== undefined ? { outputIndex: event.data.outputIndex } : {}),
        unlockTime: Number(event.data.unlockTime),
        ...(event.runId ? { runId: event.runId } : {}),
        ...(event.jobId ? { jobId: event.jobId } : {}),
      });
    } else if (event.type === "escrow.result_submitted") {
      const lock = this.locks.get(event.data.lockTxHash);
      if (!lock) {
        this.o.log.warn({ lockTxHash: event.data.lockTxHash }, "no unlock time for this escrow");
        return;
      }
      this.add(lock);
    } else if (event.type === "escrow.released" || event.type === "escrow.refunded") {
      this.drop(event.data.lockTxHash);
      this.locks.delete(event.data.lockTxHash);
    }
  }

  add(p: PendingRelease): void {
    if (this.closed || this.entries.has(p.lockTxHash)) return;
    const entry: Entry = { p, attempts: 0, firing: false };
    this.entries.set(p.lockTxHash, entry);
    const at = p.unlockTime + (this.o.afterUnlockMs ?? 60_000);
    const delay = Math.max(at - this.now(), this.o.minDelayMs ?? 0);
    this.o.log.info(
      { lockTxHash: p.lockTxHash, runId: p.runId, at: new Date(this.now() + delay).toISOString() },
      "escrow release scheduled",
    );
    this.schedule(entry, delay);
  }

  pending(): PendingRelease[] {
    return [...this.entries.values()].map((e) => e.p);
  }

  /**
   * POST /api/escrow/release: release one lock now (still only after its unlock). Answers with
   * the submit's outcome; the confirmation and escrow.released follow as for a scheduled one.
   */
  async releaseNow(p: PendingRelease): Promise<ReleaseOutcome | { busy: true }> {
    const entry = this.entries.get(p.lockTxHash) ?? { p, attempts: 0, firing: false };
    if (entry.firing) return { busy: true };
    clearTimeout(entry.timer);
    this.entries.set(p.lockTxHash, entry);
    return this.fire(entry);
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }

  private drop(lockTxHash: string): void {
    const entry = this.entries.get(lockTxHash);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(lockTxHash);
  }

  private schedule(entry: Entry, delayMs: number): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.fire(entry), delayMs);
    entry.timer.unref?.();
  }

  private retry(entry: Entry, reason: string): void {
    if (this.closed || this.entries.get(entry.p.lockTxHash) !== entry) return;
    if (entry.attempts >= (this.o.maxAttempts ?? 10)) {
      this.o.log.error({ lockTxHash: entry.p.lockTxHash, reason }, "escrow release gave up");
      this.entries.delete(entry.p.lockTxHash);
      return;
    }
    const delay = (this.o.backoffMs ?? backoff)(entry.attempts);
    this.o.log.warn({ lockTxHash: entry.p.lockTxHash, reason, delay }, "escrow release retrying");
    this.schedule(entry, delay);
  }

  private async fire(entry: Entry): Promise<ReleaseOutcome> {
    entry.firing = true;
    entry.attempts += 1;
    const { lockTxHash } = entry.p;
    let outcome: ReleaseOutcome;
    try {
      outcome = await this.o.release(entry.p);
    } catch (err) {
      outcome = {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        retry: true,
      };
    }
    if (!outcome.ok) {
      entry.firing = false;
      if (outcome.releasedIn) {
        // Already released, seen on chain (say, while the market was restarting).
        this.released(entry, outcome.releasedIn.txHash, outcome.releasedIn.plan);
      } else if (outcome.retry) {
        this.retry(entry, outcome.reason);
      } else {
        this.o.log.warn({ lockTxHash, reason: outcome.reason }, "escrow not released");
        this.entries.delete(lockTxHash);
      }
      return outcome;
    }
    const { txHash, plan, feeLovelace } = outcome;
    this.o.log.info({ lockTxHash, txHash, feeLovelace }, "escrow release submitted");
    void (async () => {
      const seen = await waitForTx(this.o.txFound, txHash, this.o.pollMs, this.o.polls);
      entry.firing = false;
      if (seen) this.released(entry, txHash, plan);
      // The next attempt finds the escrow either spent by this release, or still open.
      else this.retry(entry, "the release was not seen on chain in time");
    })();
    return outcome;
  }

  private released(entry: Entry, txHash: string, plan: ReleasePlan): void {
    const { lockTxHash, runId, jobId } = entry.p;
    this.entries.delete(lockTxHash);
    this.o.log.info({ lockTxHash, txHash, runId }, "escrow released to the seller");
    this.o.emit({
      source: "chain",
      type: "escrow.released",
      ...(runId ? { runId } : {}),
      ...(jobId ? { jobId } : {}),
      data: {
        lockTxHash,
        txHash,
        sellerAddress: plan.sellerAddress,
        buyerAddress: plan.buyerAddress,
        amountAtomic: plan.amountAtomic,
        asset: plan.asset,
        collateralReturnLovelace: plan.buyerLovelace,
        explorerUrl: explorerTxUrl(txHash),
      },
    });
  }
}
