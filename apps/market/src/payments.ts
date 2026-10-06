import {
  attachPaymentHooks,
  createResourceServer,
  PaymentOperations,
  type ResourceServerOptions,
} from "@pekkah/payments";
import type { Logger } from "@pekkah/runtime";
import type { HTTPRequestContext, x402ResourceServer } from "@x402/core/server";
import { smokeSellerFromPath } from "./dev.js";
import type { EventBus } from "./events.js";

export interface MarketPayments {
  server: x402ResourceServer;
  operations: PaymentOperations;
}

/** The resource a payment buys, from its request path. Paid job routes join in PR-06. */
export function paymentKey(request: HTTPRequestContext | undefined, txHash: string): string | null {
  if (!request) return null;
  const seller = smokeSellerFromPath(request.path);
  if (seller) return `smoke:${seller}:${txHash}`;
  if (request.path === "/api/dev/smoke-escrow") return `smoke-escrow:${txHash}`;
  return null;
}

const isDev = (key: string) => key.startsWith("smoke");

export function createMarketPayments(
  options: ResourceServerOptions,
  bus: EventBus,
  log: Logger,
): MarketPayments {
  const server = createResourceServer(options);
  const operations = new PaymentOperations();
  attachPaymentHooks(server, operations, {
    keyOf: paymentKey,
    onSettling: ({ txHash, key }) => {
      log.info({ txHash, key }, "payment settling");
      bus.emit({
        source: "market",
        type: "payment.settling",
        data: { txHash },
        ...(isDev(key) ? { dev: true } : {}),
      });
    },
    onSettled: ({ txHash, key, receipt }) => {
      log.info({ txHash, key, explorerUrl: receipt.explorerUrl }, "payment settled");
      const dev = isDev(key) ? { dev: true as const } : {};
      bus.emit({
        source: "market",
        type: "payment.settled",
        data: {
          txHash,
          explorerUrl: receipt.explorerUrl,
          transferMethod: receipt.transferMethod,
          ...(receipt.confirmations !== undefined ? { confirmations: receipt.confirmations } : {}),
        },
        ...dev,
      });
      bus.emit({
        source: "market",
        type: "receipt.issued",
        data: { receipt, resultUrl: "" },
        ...dev,
      });
    },
    onSettleFailed: ({ txHash, key, reason }) => {
      log.warn({ txHash, key, reason }, "payment settle failed");
      bus.emit({
        source: "market",
        type: "payment.failed",
        data: { txHash, reason },
        ...(isDev(key) ? { dev: true } : {}),
      });
    },
    onCanceled: ({ txHash, key, reason, status }) => {
      log.info({ txHash, key, reason, status }, "payment canceled: nothing was charged");
      bus.emit({
        source: "market",
        type: "payment.canceled",
        data: { txHash, reason },
        ...(isDev(key) ? { dev: true } : {}),
      });
    },
    warn: (message, detail) => log.warn(detail, message),
  });
  return { server, operations };
}
