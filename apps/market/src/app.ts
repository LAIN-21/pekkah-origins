import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ApiError, HealthResponse } from "@pekkah/protocol";
import express from "express";

export interface MarketAppOptions {
  version: string;
  sha: string;
  /** apps/web/dist; served at / with an SPA fallback when it holds an index.html. */
  webDist: string | null;
  workersOnline: () => number;
}

export function createApp(options: MarketAppOptions): express.Express {
  const app = express();
  // Paid routes are matched by the x402 middleware against req.path: both settings keep the
  // payment gate and the route matching identical URLs (PLAN 4.1, fact 11).
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  app.disable("x-powered-by");

  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      version: options.version,
      sha: options.sha,
      workersOnline: options.workersOnline(),
    };
    res.json(body);
  });

  app.use("/api", (_req, res) => {
    const body: ApiError = { error: "not_found" };
    res.status(404).json(body);
  });

  const index = options.webDist ? join(options.webDist, "index.html") : null;
  if (options.webDist && index && existsSync(index)) {
    app.use(express.static(options.webDist));
    app.get("*", (_req, res) => res.sendFile(index));
  }

  return app;
}
