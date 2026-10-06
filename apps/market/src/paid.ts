import {
  exactCardanoRoute,
  type PaymentOperations,
  paidRoute,
  txHashFromPaymentHeader,
} from "@pekkah/payments";
import type { Logger } from "@pekkah/runtime";
import type { HTTPRequestContext, x402ResourceServer } from "@x402/core/server";
import type express from "express";
import type { RequestHandler } from "express";
import { monotonicFactory } from "ulid";
import type { EventBus } from "./events.js";
import { type JobStore, type PaidJob, resultBody } from "./jobs.js";
import { rateLimit } from "./limits.js";
import type { OfferRecord, OfferStore } from "./offers.js";
import { runIdOf } from "./quotes.js";
import type { WorkerRegistry } from "./workers.js";

const nextJobId = monotonicFactory();

export const JOBS_PATTERN = "POST /api/jobs/:offerId";
const JOBS_PATH = /^\/api\/jobs\/([^/]+)$/i;

/** The offer a paid-job path names, as Express would decode the param. */
export function offerIdFromPath(path: string): string | null {
  const match = JOBS_PATH.exec(path);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export const offerKey = (offerId: string) => `offer:${offerId}`;

export interface PaidJobRouteOptions {
  server: x402ResourceServer;
  operations: PaymentOperations;
  offers: OfferStore;
  jobs: JobStore;
  registry: WorkerRegistry;
  bus: EventBus;
  l1Confirmations: number;
  log: Logger;
  /** Requests per minute per IP, unpaid and paid together (PLAN 5.4). */
  perMinute?: number;
}

function headerTx(header: string | undefined): string | null {
  if (!header) return null;
  try {
    return txHashFromPaymentHeader(header);
  } catch {
    return null;
  }
}

/**
 * POST /api/jobs/:offerId (PLAN 4.2): the 402 asks for the offer's price, payable to the
 * offer's worker; the handler runs the job between verify and settle, so x402 settles only
 * after delivery, and a failed job answers 502 so nothing is charged.
 */
export function registerPaidJobRoute(app: express.Express, o: PaidJobRouteOptions): void {
  const offerOf = (ctx: HTTPRequestContext): OfferRecord => {
    const id = offerIdFromPath(ctx.path);
    const record = id ? o.offers.get(id) : undefined;
    if (!record) throw new Error("unknown offer");
    return record;
  };

  const paid = paidRoute(
    JOBS_PATTERN,
    exactCardanoRoute({
      payTo: (ctx) => offerOf(ctx).offer.payTo,
      price: (ctx) => {
        const { offer } = offerOf(ctx);
        return { amount: offer.priceAtomic, asset: offer.asset };
      },
      description: "A compute job on the worker my agent accepted",
      l1Confirmations: o.l1Confirmations,
    }),
    o.server,
  );

  // Before x402: the offer exists and is open, nobody else paid for it, its worker can run it.
  // A request carrying the payment that already holds the offer (a resumed or replayed
  // request) is always admitted.
  const preCheck: RequestHandler = (req, res, next) => {
    const offerId = req.params.offerId ?? "";
    const record = o.offers.get(offerId);
    if (!record) {
      res.status(404).json({ error: "offer_not_found" });
      return;
    }
    const header = req.header("payment-signature");
    const txHash = headerTx(header);
    const holder = o.operations.activeHolder(offerKey(offerId));
    if (txHash && holder === txHash) return next();
    if (record.state === "closed") {
      res.status(410).json({ error: "offer_closed" });
      return;
    }
    if (holder) {
      res.status(409).json({ error: "offer_already_purchased" });
      return;
    }
    if (!o.offers.isPayable(record)) {
      res.status(410).json({ error: "offer_expired" });
      return;
    }
    if (!o.registry.isAvailable(record.offer.workerId)) {
      res.status(409).json({ error: "worker_unavailable" });
      return;
    }
    if (!header && record.state === "open") {
      o.offers.markRequired(offerId);
      const runId = record.runId ?? runIdOf(req);
      o.bus.emit({
        source: "market",
        type: "payment.required",
        ...(runId ? { runId } : {}),
        data: {
          offerId,
          workerId: record.offer.workerId,
          payTo: record.offer.payTo,
          amountAtomic: record.offer.priceAtomic,
          asset: record.offer.asset,
          transferMethod: "default",
        },
      });
    }
    next();
  };

  const startJob = (record: OfferRecord, txHash: string, runId: string | undefined): PaidJob => {
    const { offer, request } = record;
    o.offers.setState(offer.offerId, "claimed");
    let finish = () => {};
    const job: PaidJob = {
      jobId: nextJobId(),
      offerId: offer.offerId,
      ...(runId ? { runId } : {}),
      workerId: offer.workerId,
      workload: request.workload,
      txHash,
      status: "dispatched",
      startedAt: new Date().toISOString(),
      paid: false,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    o.jobs.add(job);
    o.operations.setData(txHash, { jobId: job.jobId });
    const common = {
      kind: "paid" as const,
      deadlineSec: request.constraints.deadlineSec,
      jobId: job.jobId,
      offerId: offer.offerId,
      txHash,
      estSec: offer.estSec,
      ...(runId ? { runId } : {}),
    };
    const dispatched =
      request.workload === "fractal"
        ? o.registry.dispatch(offer.workerId, {
            ...common,
            workload: "fractal",
            params: request.params,
          })
        : o.registry.dispatch(offer.workerId, {
            ...common,
            workload: "image",
            params: request.params,
          });
    void dispatched.then((outcome) => {
      job.endedAt = new Date().toISOString();
      job.durationMs = outcome.durationMs;
      if (outcome.ok) {
        job.status = "delivered";
        job.sha256 = outcome.sha256;
        job.mime = outcome.mime;
        job.data = outcome.data;
      } else {
        job.status = "failed";
        job.error = outcome.error;
      }
      finish();
    });
    return job;
  };

  app.post("/api/jobs/:offerId", rateLimit(o.perMinute ?? 10), preCheck, paid, async (req, res) => {
    try {
      const record = o.offers.get(req.params.offerId ?? "");
      const txHash = headerTx(req.header("payment-signature"));
      // Defence in depth: only a payment every verify hook accepted gets here.
      if (!record || !txHash || !o.operations.isVerified(txHash)) {
        res.status(402).json({ error: "payment_required" });
        return;
      }
      const runId = record.runId ?? runIdOf(req);
      if (o.operations.firstTime(txHash, "verified")) {
        o.bus.emit({
          source: "market",
          type: "payment.verified",
          ...(runId ? { runId } : {}),
          data: {
            txHash,
            offerId: record.offer.offerId,
            workerId: record.offer.workerId,
            payTo: record.offer.payTo,
            amountAtomic: record.offer.priceAtomic,
            transferMethod: "default",
          },
        });
      }
      // One job per payment: a resumed or replayed request awaits or returns the same job.
      const job = o.jobs.byTxHash(txHash) ?? startJob(record, txHash, runId);
      await job.done;
      if (job.status === "delivered") {
        res.json(resultBody(job));
        return;
      }
      res.status(502).json({ error: "job_failed", reason: job.error ?? "the job failed" });
    } catch (err) {
      o.log.error({ err }, "paid job handler failed");
      if (!res.headersSent) res.status(500).json({ error: "internal" });
      else res.end();
    }
  });
}
