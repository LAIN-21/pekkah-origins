import { match } from "@pekkah/matcher";
import { ComputeRequest, Id, RUN_ID_HEADER, type WorkerSnapshot } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import express from "express";
import { monotonicFactory } from "ulid";
import type { EventBus } from "./events.js";
import { rateLimit } from "./limits.js";
import { buildQuote, type OfferStore } from "./offers.js";

const nextId = monotonicFactory();

export interface QuoteRouteOptions {
  workers: () => WorkerSnapshot[];
  offers: OfferStore;
  bus: EventBus;
  asset: string;
  log: Logger;
}

/** The run a request belongs to, from X-Pekkah-Run-Id; everything that follows is tagged with it. */
export function runIdOf(req: express.Request): string | undefined {
  const value = req.header(RUN_ID_HEADER);
  return value && Id.safeParse(value).success ? value : undefined;
}

/** POST /api/quote: a ComputeRequest in, a Quote out (PLAN 4.2, 6.1). 30 per minute per IP. */
export function registerQuoteRoute(app: express.Express, o: QuoteRouteOptions): void {
  app.post("/api/quote", rateLimit(30), express.json({ limit: "16kb" }), (req, res) => {
    try {
      const parsed = ComputeRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", issues: parsed.error.issues.slice(0, 5) });
        return;
      }
      const runId = runIdOf(req);
      const now = Date.now();
      const result = match(parsed.data, o.workers(), new Date(now));
      const { quote, records } = buildQuote(parsed.data, result, {
        quoteId: nextId(),
        ...(runId ? { runId } : {}),
        asset: o.asset,
        now,
        nextId,
      });
      o.offers.add(records);
      o.bus.emit({
        source: "market",
        type: "quote.issued",
        data: { quote },
        ...(runId ? { runId } : {}),
      });
      res.json(quote);
    } catch (err) {
      o.log.error({ err }, "quote failed");
      if (!res.headersSent) res.status(500).json({ error: "internal" });
      else res.end();
    }
  });
}
