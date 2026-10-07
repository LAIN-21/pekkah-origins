import { AGENT_EVENT_TYPES, AgentEventsBody, type JobEventInput, TxHash } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import type { EventBus } from "./events.js";
import { type JobStore, jobView } from "./jobs.js";
import { rateLimit } from "./limits.js";
import type { RunStore } from "./runs.js";

const TX_HASH = /^[0-9a-f]{64}$/;

export interface ReadRouteOptions {
  jobs: JobStore;
  runs: RunStore;
  facilitatorUrl: string;
  log: Logger;
}

/** Job status, paid results, on-chain status and run logs (PLAN 5.4). */
export function registerReadRoutes(app: express.Express, o: ReadRouteOptions): void {
  app.get("/api/jobs/by-tx/:txHash", (req, res) => {
    const job = o.jobs.byTxHash(req.params.txHash ?? "");
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(jobView(job));
  });

  app.get("/api/jobs/:jobId", (req, res) => {
    const job = o.jobs.get(req.params.jobId ?? "");
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(jobView(job));
  });

  // The result is the paid product: readable only once the payment settled.
  app.get("/api/results/:jobId", (req, res) => {
    const job = o.jobs.get(req.params.jobId ?? "");
    if (!job?.data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!job.paid) {
      res.status(402).json({ error: "not_paid" });
      return;
    }
    res.type(job.mime ?? "application/octet-stream").send(job.data);
  });

  // The facilitator is never published: the market forwards its on-chain lookup.
  app.get("/api/tx/:hash", rateLimit(30), async (req, res) => {
    try {
      const hash = req.params.hash ?? "";
      const ttl = req.query.ttlSlot;
      if (!TX_HASH.test(hash) || (ttl !== undefined && !/^\d{1,15}$/.test(String(ttl)))) {
        res.status(400).json({ error: "invalid_tx_hash" });
        return;
      }
      const query = ttl === undefined ? "" : `?ttlSlot=${ttl}`;
      const upstream = await fetch(`${o.facilitatorUrl.replace(/\/+$/, "")}/tx/${hash}${query}`, {
        signal: AbortSignal.timeout(20_000),
      });
      res.status(upstream.status).json(await upstream.json());
    } catch (err) {
      o.log.warn({ err: err instanceof Error ? err.message : err }, "tx lookup failed");
      if (!res.headersSent) res.status(502).json({ error: "lookup_failed" });
      else res.end();
    }
  });

  app.get("/api/runs/latest", (_req, res) => {
    const run = o.runs.latest();
    if (!run) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(run);
  });

  app.get("/api/runs/:runId/events", (req, res) => {
    const run = o.runs.get(req.params.runId ?? "");
    if (!run) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(run);
  });
}

/** POST /api/agent-events (Bearer AGENT_TOKEN): the agent's own events into the bus. */
/**
 * PR-16b: a chain event my agent reports (a refund it sent), checked on chain before the
 * market emits it. Absent while the market has no chain access (Masumi off).
 */
export interface ReportedChainEvents {
  refunded(report: {
    lockTxHash: string;
    txHash: string;
  }): Promise<{ ok: true; event: JobEventInput | null } | { ok: false; reason: string }>;
}

const Refunded = z.object({ lockTxHash: TxHash, txHash: TxHash });

export function registerAgentEvents(
  app: express.Express,
  guard: RequestHandler,
  bus: EventBus,
  reported?: ReportedChainEvents,
): void {
  app.post("/api/agent-events", guard, express.json({ limit: "256kb" }), async (req, res) => {
    try {
      const parsed = AgentEventsBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_events", issues: parsed.error.issues.slice(0, 5) });
        return;
      }
      let accepted = 0;
      const reasons: string[] = [];
      for (const post of parsed.data.events) {
        if (post.type === "escrow.refunded") {
          const report = Refunded.safeParse(post.data);
          if (!report.success || !reported) {
            reasons.push(report.success ? "the market has no chain access" : "invalid refund");
            continue;
          }
          const checked = await reported.refunded(report.data);
          if (!checked.ok) {
            reasons.push(checked.reason);
            continue;
          }
          // null: the run already records this refund, so it is not emitted twice.
          if (!checked.event || bus.emit(checked.event)) accepted += 1;
          continue;
        }
        if (!(AGENT_EVENT_TYPES as readonly string[]).includes(post.type)) continue;
        const { ts: _ts, ...rest } = post;
        const event = bus.emit({ ...rest, source: "agent" } as JobEventInput);
        if (event) accepted += 1;
      }
      const rejected = parsed.data.events.length - accepted;
      res
        .status(rejected ? (reasons.length ? 422 : 400) : 202)
        .json({ accepted, rejected, ...(reasons.length ? { reasons } : {}) });
    } catch {
      // Only the chain check can throw: the facilitator or Blockfrost was unreachable.
      if (!res.headersSent) res.status(502).json({ error: "chain_unavailable" });
      else res.end();
    }
  });
}
