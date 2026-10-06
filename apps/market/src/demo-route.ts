import { createHash, timingSafeEqual } from "node:crypto";
import { DemoRunRequest } from "@pekkah/protocol";
import express from "express";
import type { DemoController } from "./demo.js";
import { rateLimit } from "./limits.js";

function isBearer(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const given = createHash("sha256").update(header.slice(7)).digest();
  return timingSafeEqual(given, createHash("sha256").update(token).digest());
}

/** POST /api/demo/run {scenario, promptIndex?}: 2 a minute per IP (PLAN 5.4). */
export function registerDemoRoute(
  app: express.Express,
  demo: DemoController,
  demoToken: string | undefined,
): void {
  app.post("/api/demo/run", rateLimit(2), express.json({ limit: "1kb" }), async (req, res) => {
    try {
      const parsed = DemoRunRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const result = await demo.start(
        parsed.data,
        isBearer(req.header("authorization"), demoToken),
      );
      res.status(result.status).json(result.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "internal" });
      else res.end();
    }
  });
}
