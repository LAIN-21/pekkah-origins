import {
  attachPaymentHooks,
  createResourceServer,
  PaymentOperations,
  type ResourceServerOptions,
} from "@pekkah/payments";
import type { JobEventInput } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import type { HTTPRequestContext, x402ResourceServer } from "@x402/core/server";
import { smokeSellerFromPath } from "./dev.js";
import type { EventBus } from "./events.js";
import type { JobStore } from "./jobs.js";
import type { OfferStore } from "./offers.js";
import { offerIdFromPath, offerKey } from "./paid.js";

export interface MarketPayments {
  server: x402ResourceServer;
  operations: PaymentOperations;
}

/** The single resource a payment buys, from its request path. */
export function paymentKey(request: HTTPRequestContext | undefined, txHash: string): string | null {
  if (!request) return null;
  const offerId = offerIdFromPath(request.path);
  if (offerId) return offerKey(offerId);
  const seller = smokeSellerFromPath(request.path);
  if (seller) return `smoke:${seller}:${txHash}`;
  if (request.path === "/api/dev/smoke-escrow") return `smoke-escrow:${txHash}`;
  return null;
}

const isDev = (key: string) => key.startsWith("smoke");
const offerIdOfKey = (key: string) => (key.startsWith("offer:") ? key.slice(6) : null);

export function createMarketPayments(
  options: ResourceServerOptions,
  bus: EventBus,
  log: Logger,
  stores: { jobs: JobStore; offers: OfferStore },
): MarketPayments {
  const server = createResourceServer(options);
  const operations = new PaymentOperations();

  /** Payment events carry the run of the offer they pay for; smoke payments are dev events. */
  const emit = (key: string, event: Omit<JobEventInput, "source">) => {
    const offerId = offerIdOfKey(key);
    const runId = offerId ? stores.offers.get(offerId)?.runId : undefined;
    bus.emit({
      ...event,
      source: "market",
      ...(runId ? { runId } : {}),
      ...(isDev(key) ? { dev: true } : {}),
    } as JobEventInput);
  };

  attachPaymentHooks(server, operations, {
    keyOf: paymentKey,
    onSettling: ({ txHash, key }) => {
      log.info({ txHash, key }, "payment settling");
      emit(key, { type: "payment.settling", data: { txHash } });
    },
    onSettled: ({ txHash, key, receipt }) => {
      log.info({ txHash, key, explorerUrl: receipt.explorerUrl }, "payment settled");
      const job = stores.jobs.byTxHash(txHash);
      if (job) job.paid = true;
      emit(key, {
        type: "payment.settled",
        ...(job ? { jobId: job.jobId } : {}),
        data: {
          txHash,
          explorerUrl: receipt.explorerUrl,
          transferMethod: receipt.transferMethod,
          ...(receipt.confirmations !== undefined ? { confirmations: receipt.confirmations } : {}),
        },
      });
      emit(key, {
        type: "receipt.issued",
        ...(job ? { jobId: job.jobId } : {}),
        data: { receipt, resultUrl: job ? `/api/results/${job.jobId}` : "" },
      });
    },
    onSettleFailed: ({ txHash, key, reason }) => {
      // The result stays with the market; PR-09 keeps watching for a late settlement.
      log.warn({ txHash, key, reason }, "payment settle failed");
      emit(key, { type: "payment.failed", data: { txHash, reason } });
    },
    onCanceled: ({ txHash, key, reason, status }) => {
      log.info({ txHash, key, reason, status }, "payment canceled: nothing was charged");
      const offerId = offerIdOfKey(key);
      if (offerId) stores.offers.setState(offerId, "closed");
      emit(key, { type: "payment.canceled", data: { txHash, reason } });
    },
    warn: (message, detail) => log.warn(detail, message),
  });
  return { server, operations };
}
