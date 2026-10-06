import {
  assertMasumiRoute,
  exactCardanoRoute,
  masumiRoute,
  type PaymentOperations,
  paidRoute,
  txHashFromPaymentHeader,
} from "@pekkah/payments";
import { NETWORK, type TransferMethod } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import { masumiEscrowAddress } from "@x402/cardano";
import type { HTTPRequestContext, RouteConfig, x402ResourceServer } from "@x402/core/server";
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
export const ESCROW_JOBS_PATTERN = "POST /api/escrow-jobs/:offerId";
const JOBS_PATH = /^\/api\/(jobs|escrow-jobs)\/([^/]+)$/i;

function decode(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The offer a paid-job or escrow-job path names, as Express would decode the param. */
export function offerIdFromPath(path: string): string | null {
  return decode(JOBS_PATH.exec(path)?.[2]);
}

/** The offer an escrow-job path names: its escrow commits to that offer's request. */
export function escrowOfferIdFromPath(path: string): string | null {
  const match = JOBS_PATH.exec(path);
  return match?.[1]?.toLowerCase() === "escrow-jobs" ? decode(match[2]) : null;
}

/** An offer can be bought once, through either route. */
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
  /**
   * Enables POST /api/escrow-jobs/:offerId (PR-10): the payment is locked in Masumi's escrow
   * with the offer's worker as seller. Only that worker sells through escrow.
   */
  masumi?: { sellerAddress: string; asset: string; unpaidPerMinute?: number };
}

function headerTx(header: string | undefined): string | null {
  if (!header) return null;
  try {
    return txHashFromPaymentHeader(header);
  } catch {
    return null;
  }
}

/** Counts only requests without a payment: each unpaid escrow 402 signs a fresh seller quote. */
function unpaidLimit(perMinute: number): RequestHandler {
  const limit = rateLimit(perMinute);
  return (req, res, next) => (req.header("payment-signature") ? next() : limit(req, res, next));
}

/**
 * POST /api/jobs/:offerId (PLAN 4.2): the 402 asks for the offer's price, payable to the
 * offer's worker; the handler runs the job between verify and settle, so x402 settles only
 * after delivery, and a failed job answers 502 so nothing is charged.
 * POST /api/escrow-jobs/:offerId (PLAN 4.8): the same, but the payment is locked in Masumi's
 * escrow, bound to the offer's request, with the worker as seller. Nothing is released.
 */
export function registerPaidJobRoute(app: express.Express, o: PaidJobRouteOptions): void {
  const offerOf = (ctx: HTTPRequestContext): OfferRecord => {
    const id = offerIdFromPath(ctx.path);
    const record = id ? o.offers.get(id) : undefined;
    if (!record) throw new Error("unknown offer");
    return record;
  };
  const priceOf = (ctx: HTTPRequestContext) => {
    const { offer } = offerOf(ctx);
    return { amount: offer.priceAtomic, asset: offer.asset };
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

  const register = (
    method: TransferMethod,
    path: string,
    pattern: string,
    route: RouteConfig,
    extra: RequestHandler[],
  ) => {
    // Where the money goes: the worker, or the escrow with the worker as seller.
    const payToOf = (record: OfferRecord) =>
      method === "masumi" ? masumiEscrowAddress(NETWORK) : record.offer.payTo;

    // Before x402: the offer exists and is open, nobody else paid for it, its worker can run
    // it. A request carrying the payment that already holds the offer (a resumed or replayed
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
      if (method === "masumi" && record.offer.payTo !== o.masumi?.sellerAddress) {
        res.status(409).json({ error: "not_a_masumi_seller" });
        return;
      }
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
            payTo: payToOf(record),
            amountAtomic: record.offer.priceAtomic,
            asset: record.offer.asset,
            transferMethod: method,
          },
        });
      }
      next();
    };

    const paid = paidRoute(pattern, route, o.server);

    app.post(path, rateLimit(o.perMinute ?? 10), ...extra, preCheck, paid, async (req, res) => {
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
              payTo: payToOf(record),
              amountAtomic: record.offer.priceAtomic,
              transferMethod: method,
            },
          });
        }
        // One job per payment: a resumed or replayed request awaits or returns the same job.
        // If that job was already trimmed from memory, refuse rather than run a second one.
        const existing = o.jobs.byTxHash(txHash);
        const startedBefore = (o.operations.get(txHash)?.data as { jobId?: string } | undefined)
          ?.jobId;
        if (!existing && startedBefore) {
          res.status(410).json({ error: "job_expired" });
          return;
        }
        const job = existing ?? startJob(record, txHash, runId);
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
  };

  // Registered directly on app, with the payment gate in each route's own chain (fact 11).
  register(
    "default",
    "/api/jobs/:offerId",
    JOBS_PATTERN,
    exactCardanoRoute({
      payTo: (ctx) => offerOf(ctx).offer.payTo,
      price: priceOf,
      description: "A compute job on the worker my agent accepted",
      l1Confirmations: o.l1Confirmations,
    }),
    [],
  );

  if (o.masumi) {
    const route = masumiRoute({
      price: priceOf,
      description:
        "A compute job; the payment is locked in Masumi escrow with the worker as seller",
      l1Confirmations: o.l1Confirmations,
    });
    // The library checks a template only per request; refuse to boot with a bad one.
    assertMasumiRoute(route, { amount: "50000", asset: o.masumi.asset });
    register("masumi", "/api/escrow-jobs/:offerId", ESCROW_JOBS_PATTERN, route, [
      unpaidLimit(o.masumi.unpaidPerMinute ?? 6),
    ]);
  }
}
