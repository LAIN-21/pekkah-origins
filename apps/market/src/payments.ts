import {
  attachPaymentHooks,
  buildReceipt,
  createResourceServer,
  decodeSignedTx,
  PaymentOperations,
  type ResourceServerOptions,
} from "@pekkah/payments";
import {
  type JobEventInput,
  MAX_TIMEOUT_SECONDS,
  NETWORK,
  type PaymentReceipt,
} from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import { slotToPosixMs } from "@x402/cardano";
import type { HTTPRequestContext, x402ResourceServer } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { smokeSellerFromPath } from "./dev.js";
import { escrowLock } from "./escrow.js";
import type { EventBus } from "./events.js";
import type { JobStore } from "./jobs.js";
import type { OfferStore } from "./offers.js";
import { offerIdFromPath, offerKey } from "./paid.js";
import { createResultPublisher, type EscrowResults } from "./result-publish.js";

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
  escrowResults?: EscrowResults,
): MarketPayments {
  const facilitator =
    options.facilitator ??
    new HTTPFacilitatorClient({
      url: options.facilitatorUrl,
      timeoutMs: options.timeoutMs ?? 120_000,
    });
  const server = createResourceServer({ ...options, facilitator });
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

  /**
   * payment.settled, then escrow.locked for a Masumi lock, then receipt.issued. For an escrow
   * job, settled means the lock transaction landed: the funds are locked in escrow.
   */
  const publishResult = escrowResults
    ? createResultPublisher({ ...escrowResults, emit, log })
    : undefined;

  const settled = (
    key: string,
    txHash: string,
    receipt: PaymentReceipt,
    requirements: PaymentRequirements,
    paymentPayload: PaymentPayload,
    late: boolean,
  ) => {
    const job = stores.jobs.byTxHash(txHash);
    if (job) job.paid = true;
    const jobRef = job ? { jobId: job.jobId } : {};
    emit(key, {
      type: "payment.settled",
      ...jobRef,
      data: {
        txHash,
        explorerUrl: receipt.explorerUrl,
        transferMethod: receipt.transferMethod,
        ...(late ? { late: true } : {}),
        ...(receipt.confirmations !== undefined ? { confirmations: receipt.confirmations } : {}),
      },
    });
    if (receipt.transferMethod === "masumi") {
      try {
        const result = escrowLock({ txHash, requirements, paymentPayload });
        if ("lock" in result) {
          emit(key, { type: "escrow.locked", ...jobRef, data: result.lock });
          // PR-10b: record the delivered result in the escrow, as the seller.
          if (publishResult && job?.sha256) {
            publishResult({
              key,
              jobId: job.jobId,
              lockTxHash: txHash,
              outputIndex: result.outputIndex,
              resultHash: job.sha256,
            });
          }
        } else log.error({ txHash, key, reason: result.error }, "escrow lock not reported");
      } catch (err) {
        log.error({ txHash, key, err }, "escrow lock not reported");
      }
    }
    emit(key, {
      type: "receipt.issued",
      ...jobRef,
      data: { receipt, resultUrl: job ? `/api/results/${job.jobId}` : "" },
    });
  };

  // Late settlement (PLAN 4.4): the transaction may still land after settle gave up. Keep the
  // result and ask the facilitator again every 20 s; that resumes watching the same
  // transaction and never broadcasts it again. The market itself never calls Blockfrost.
  const watching = new Set<string>();
  const settleLate = (
    txHash: string,
    key: string,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ) => {
    if (watching.has(txHash)) return;
    watching.add(txHash);
    // Until the chain passes the transaction's own TTL (plus a minute for the block to be
    // seen); without a TTL, the longest window a payment can have.
    let deadline = Date.now() + MAX_TIMEOUT_SECONDS * 1000;
    try {
      const ttl = decodeSignedTx(payload).ttlSlot;
      if (ttl !== undefined) deadline = slotToPosixMs(NETWORK, ttl) + 60_000;
    } catch {
      // Keep the fallback.
    }
    const stop = (reason: string) => {
      watching.delete(txHash);
      log.warn({ txHash, key, reason }, "late settlement gave up");
      emit(key, { type: "payment.failed", data: { txHash, reason } });
    };
    const tick = async () => {
      try {
        const result = await facilitator.settle(payload, requirements);
        if (result.success) {
          watching.delete(txHash);
          operations.recordSettle(txHash, result);
          const receipt = buildReceipt({ paymentPayload: payload, requirements, settle: result });
          const what = receipt.transferMethod === "masumi" ? "locked in escrow" : "payment settled";
          log.info({ txHash, key }, `${what} late`);
          settled(key, txHash, receipt, requirements, payload, true);
          return;
        }
        if (result.errorReason !== "settlement_pending") {
          return stop(`the transaction did not land (${result.errorReason ?? "unknown"})`);
        }
      } catch (err) {
        log.warn(
          { txHash, err: err instanceof Error ? err.message : err },
          "late settle attempt failed",
        );
      }
      if (Date.now() >= deadline) return stop("the validity window closed");
      setTimeout(() => void tick(), 20_000);
    };
    setTimeout(() => void tick(), 20_000);
  };

  attachPaymentHooks(server, operations, {
    keyOf: paymentKey,
    onSettling: ({ txHash, key, requirements }) => {
      const masumi = requirements.extra?.assetTransferMethod === "masumi";
      log.info({ txHash, key }, masumi ? "locking in escrow" : "payment settling");
      emit(key, {
        type: "payment.settling",
        data: { txHash, transferMethod: masumi ? "masumi" : "default" },
      });
    },
    onSettled: ({ txHash, key, receipt, requirements, paymentPayload }) => {
      const what = receipt.transferMethod === "masumi" ? "locked in escrow" : "payment settled";
      log.info({ txHash, key, explorerUrl: receipt.explorerUrl }, what);
      settled(key, txHash, receipt, requirements, paymentPayload, false);
    },
    onSettleFailed: ({ txHash, key, reason, errorReason, paymentPayload, requirements }) => {
      // The result stays with the market; a pending transaction is watched until it lands.
      log.warn({ txHash, key, reason, errorReason }, "payment settle failed");
      if (errorReason === "settlement_pending") {
        emit(key, {
          type: "payment.failed",
          data: { txHash, reason: "settlement pending: still watching the transaction" },
        });
        settleLate(txHash, key, paymentPayload, requirements);
        return;
      }
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
