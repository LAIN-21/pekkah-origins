import { createHash, timingSafeEqual } from "node:crypto";
import {
  assertMasumiRoute,
  exactCardanoRoute,
  masumiRoute,
  type PaymentOperations,
  paidRoute,
  txHashFromPaymentHeader,
} from "@pekkah/payments";
import type { Logger } from "@pekkah/runtime";
import type { x402ResourceServer } from "@x402/core/server";
import express, { type RequestHandler } from "express";

// Dev-only routes (PLAN 5.4): registered only with PEKKAH_DEV_ROUTES=1, and every request must
// carry Bearer DEMO_TOKEN. PR-11 turns them off in production.

export function bearerGuard(token: string): RequestHandler {
  const expected = createHash("sha256").update(token).digest();
  return (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    const ok = timingSafeEqual(createHash("sha256").update(given).digest(), expected);
    if (ok) return next();
    res.status(401).json({ error: "unauthorized" });
  };
}

export const SMOKE_PATTERN = "POST /api/dev/smoke/:seller";
export const SMOKE_PRICE_ATOMIC = "10000";
const SMOKE_PATH = /^\/api\/dev\/smoke\/([^/]+)$/i;

/** The seller named in a smoke-route path, as Express would decode the param. */
export function smokeSellerFromPath(path: string): string | null {
  const match = SMOKE_PATH.exec(path);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export interface SmokeRouteOptions {
  server: x402ResourceServer;
  operations: PaymentOperations;
  /** Seller id (A, B, C) → address, from SELLER_{A,B,C}_ADDRESS. */
  sellers: Record<string, string>;
  asset: string;
  l1Confirmations: number;
  log: Logger;
}

/** The txHash of a payment every verify hook passed, or null: the handler's own precondition. */
function verifiedTx(header: string | undefined, operations: PaymentOperations): string | null {
  try {
    const txHash = header ? txHashFromPaymentHeader(header) : null;
    return txHash && operations.isVerified(txHash) ? txHash : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/dev/smoke/:seller: a real $0.01 x402 payment to the seller's address, chosen per
 * request. The handler does real, trivial work (it hashes the body) or answers 500 with
 * ?fail=1, so x402 never settles.
 */
export function registerSmokeRoute(
  app: express.Express,
  guard: RequestHandler,
  o: SmokeRouteOptions,
) {
  const sellerAddress = (seller: string | null) => (seller ? o.sellers[seller] : undefined);

  const preCheck: RequestHandler = (req, res, next) => {
    if (!sellerAddress(req.params.seller ?? null)) {
      res.status(404).json({ error: "unknown_seller" });
      return;
    }
    next();
  };

  const paid = paidRoute(
    SMOKE_PATTERN,
    exactCardanoRoute({
      payTo: (ctx) => {
        const address = sellerAddress(smokeSellerFromPath(ctx.path));
        if (!address) throw new Error("unknown seller");
        return address;
      },
      price: { amount: SMOKE_PRICE_ATOMIC, asset: o.asset },
      description: "Pekkah smoke payment (dev only)",
      l1Confirmations: o.l1Confirmations,
    }),
    o.server,
  );

  // Registered directly on app, with the payment gate in the route's own chain (fact 11).
  app.post(
    "/api/dev/smoke/:seller",
    guard,
    preCheck,
    express.raw({ type: () => true, limit: "16kb" }),
    paid,
    async (req, res) => {
      try {
        // Defence in depth: refuse unless every verify hook passed for this payment.
        const txHash = verifiedTx(req.header("payment-signature"), o.operations);
        if (!txHash) {
          res.status(402).json({ error: "payment_required" });
          return;
        }
        const seller = req.params.seller ?? "";
        if (req.query.fail === "1") {
          o.log.info({ txHash, seller }, "smoke: failing on purpose; nothing will be charged");
          res.status(500).json({ error: "smoke_failure_requested", txHash });
          return;
        }
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const sha256 = createHash("sha256").update(body).digest("hex");
        res.json({
          ok: true,
          seller,
          payTo: sellerAddress(seller),
          bytes: body.length,
          sha256,
          txHash,
        });
      } catch (err) {
        o.log.error({ err }, "smoke handler failed");
        if (!res.headersSent) res.status(500).json({ error: "internal" });
        else res.end();
      }
    },
  );
}

export const SMOKE_ESCROW_PATTERN = "POST /api/dev/smoke-escrow";

export interface SmokeEscrowRouteOptions {
  server: x402ResourceServer;
  operations: PaymentOperations;
  asset: string;
  l1Confirmations: number;
  log: Logger;
}

/**
 * POST /api/dev/smoke-escrow (PR-02m, the Masumi feasibility gate): a real $0.01 lock in
 * Masumi's escrow with worker A as the seller, committed to the resource URL (the library
 * default). Nothing is released: I implement the lock only.
 */
export function registerSmokeEscrowRoute(
  app: express.Express,
  guard: RequestHandler,
  o: SmokeEscrowRouteOptions,
) {
  const price = { amount: SMOKE_PRICE_ATOMIC, asset: o.asset };
  const route = masumiRoute({
    price,
    description: "Pekkah Masumi escrow smoke lock (dev only)",
    l1Confirmations: o.l1Confirmations,
  });
  assertMasumiRoute(route, price);
  app.post(
    "/api/dev/smoke-escrow",
    guard,
    express.raw({ type: () => true, limit: "16kb" }),
    paidRoute(SMOKE_ESCROW_PATTERN, route, o.server),
    async (req, res) => {
      try {
        const txHash = verifiedTx(req.header("payment-signature"), o.operations);
        if (!txHash) {
          res.status(402).json({ error: "payment_required" });
          return;
        }
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const sha256 = createHash("sha256").update(body).digest("hex");
        res.json({ ok: true, escrow: true, bytes: body.length, sha256, txHash });
      } catch (err) {
        o.log.error({ err }, "smoke-escrow handler failed");
        if (!res.headersSent) res.status(500).json({ error: "internal" });
        else res.end();
      }
    },
  );
}
