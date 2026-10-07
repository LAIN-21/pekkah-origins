import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@pekkah/runtime";

/**
 * The refunds the market has recorded, by lock (PR-16b). A refund of a lock with a run is
 * already in that run; a lock with no run (a dev smoke lock) is not, so a repeated report
 * would emit escrow.refunded again. Kept in DATA_DIR/refunds.json, so a restart keeps it too;
 * writing is best effort, like the run logs.
 */
export class ReportedRefunds {
  private readonly refunds = new Map<string, string>();
  private readonly file: string | null;

  constructor(
    dir: string | null,
    private readonly log: Logger,
  ) {
    this.file = dir ? join(dir, "refunds.json") : null;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      for (const [lock, tx] of Object.entries(saved)) {
        if (/^[0-9a-f]{64}$/.test(lock) && typeof tx === "string" && /^[0-9a-f]{64}$/.test(tx)) {
          this.refunds.set(lock, tx);
        }
      }
    } catch {
      // No refunds recorded yet, or an unreadable file: start empty.
    }
  }

  has(lockTxHash: string, txHash: string): boolean {
    return this.refunds.get(lockTxHash) === txHash;
  }

  add(lockTxHash: string, txHash: string): void {
    this.refunds.set(lockTxHash, txHash);
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.refunds)));
    } catch (err) {
      this.log.warn({ err }, "could not save the recorded refunds; keeping them in memory");
    }
  }
}
