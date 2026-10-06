import { explorerTxUrl, TxHash } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import type { EscrowReleaser } from "./escrow-release.js";
import { rateLimit } from "./limits.js";
import type { ReleaseScheduler } from "./release-scheduler.js";
import type { RunStore } from "./runs.js";

const ReleaseRequest = z.object({
  lockTxHash: TxHash,
  /** The lock's escrow output; the run log knows it for the market's own locks. */
  outputIndex: z.number().int().nonnegative().optional(),
  dryRun: z.boolean().optional(),
});

/**
 * POST /api/escrow/release {lockTxHash, dryRun?}, Bearer DEMO_TOKEN only: releases a lock the
 * scheduler doesn't know. It's harmless: a release only ever pays the price to the escrow's
 * seller (Seller A) and returns the buyer's collateral, and only after the unlock. A dry run
 * builds and evaluates the Withdraw and signs nothing.
 */
export function registerEscrowReleaseRoute(
  app: express.Express,
  guard: RequestHandler,
  o: { releases: ReleaseScheduler; release: EscrowReleaser; runs: RunStore; log: Logger },
): void {
  app.post(
    "/api/escrow/release",
    rateLimit(10),
    guard,
    express.json({ limit: "1kb" }),
    async (req, res) => {
      try {
        const parsed = ReleaseRequest.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "invalid_request" });
          return;
        }
        const { lockTxHash, dryRun } = parsed.data;
        const lock = o.runs.findLock(lockTxHash);
        const outputIndex = parsed.data.outputIndex ?? lock?.outputIndex;
        const index = outputIndex !== undefined ? { outputIndex } : {};
        if (dryRun) {
          const outcome = await o.release(lockTxHash, { dryRun: true, ...index });
          res.status(outcome.ok ? 200 : 409).json(outcome);
          return;
        }
        if (lock?.releasedTxHash) {
          res.json({ released: true, txHash: lock.releasedTxHash, runId: lock.runId });
          return;
        }
        const outcome = await o.releases.releaseNow({
          lockTxHash,
          ...index,
          unlockTime: lock?.unlockTime ?? 0,
          ...(lock ? { runId: lock.runId } : {}),
          ...(lock?.jobId ? { jobId: lock.jobId } : {}),
        });
        if ("busy" in outcome) {
          res.status(409).json({ error: "release_in_progress" });
          return;
        }
        if (outcome.ok) {
          const { txHash, plan, feeLovelace } = outcome;
          res.status(202).json({
            txHash,
            explorerUrl: explorerTxUrl(txHash),
            plan,
            feeLovelace,
            ...(lock ? { runId: lock.runId } : {}),
          });
          return;
        }
        if (outcome.releasedIn) {
          res.json({ released: true, txHash: outcome.releasedIn.txHash });
          return;
        }
        res.status(409).json({ error: "not_released", reason: outcome.reason });
      } catch (err) {
        o.log.error({ err }, "escrow release route failed");
        if (!res.headersSent) res.status(500).json({ error: "internal" });
        else res.end();
      }
    },
  );
}
