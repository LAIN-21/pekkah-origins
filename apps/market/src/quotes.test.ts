import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_ASSET,
  Quote,
  scenarioRequest,
  UiMessage,
  usdToAtomic,
  type WorkerSnapshot,
  type WorkloadName,
} from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EventBus } from "./events.js";
import { buildQuote, OfferStore } from "./offers.js";
import { registerQuoteRoute } from "./quotes.js";
import { UiHub } from "./ui.js";

const log = createLogger("quotes-test");
const AT = new Date().toISOString();
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function snapshot(
  id: string,
  prices: Partial<Record<WorkloadName, number>>,
  spi: number,
  selling = true,
): WorkerSnapshot {
  return {
    workerId: id,
    name: `Worker ${id}`,
    payTo: `addr_test1vq${id.toLowerCase().replace("b", "z").repeat(51)}`,
    hardware: { cpuModel: "test", vcpus: 8, memGb: 16 },
    prices: Object.entries(prices).map(([workload, usd]) => ({
      workload: workload as WorkloadName,
      usd: usd as number,
      atomic: usdToAtomic(usd as number),
    })),
    status: "online",
    calibration: {
      fractal: {
        overheadSec: 1,
        calibSec: 2,
        secPerIter: spi,
        verified: true,
        challenge: 0,
        at: AT,
      },
    },
    warm: ["fractal"],
    lastSeenAt: AT,
    selling,
  };
}
const workers = [
  snapshot("A", { fractal: 0.05 }, 3.5e-9),
  snapshot("B", { fractal: 0.03 }, 2.8e-9),
  snapshot("C", { fractal: 0.02 }, 11e-9),
];

async function start(list: WorkerSnapshot[] = workers) {
  const bus = new EventBus(log);
  const offers = new OfferStore();
  const app = express();
  registerQuoteRoute(app, { workers: () => list, offers, bus, asset: DEFAULT_ASSET, log });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  cleanup.push(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const quote = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { bus, offers, quote };
}

describe("POST /api/quote", () => {
  it("answers cpu-counter with the market price and a counter-offer from C", async () => {
    const { quote, bus, offers } = await start();
    const res = await quote(scenarioRequest("cpu-counter"), { "X-Pekkah-Run-Id": "01RUN" });
    expect(res.status).toBe(200);
    const q = Quote.parse(await res.json());
    expect(q.runId).toBe("01RUN");
    expect(q.offers).toEqual([]);
    expect(q.marketPriceUsd).toBe(0.03);
    expect(q.counterOffer).toMatchObject({
      workerId: "C",
      kind: "counter",
      priceAtomic: "20000",
      asset: DEFAULT_ASSET,
    });
    expect(offers.get(q.counterOffer?.offerId ?? "")?.request).toEqual(q.request);
    const [event] = bus.latest();
    expect(event).toMatchObject({ type: "quote.issued", runId: "01RUN", source: "market" });
  });

  it("answers cpu-tight with B, A over budget and C too slow", async () => {
    const { quote } = await start();
    const q = Quote.parse(await (await quote(scenarioRequest("cpu-tight"))).json());
    expect(q.offers.map((o) => [o.workerId, o.kind, o.priceUsd])).toEqual([["B", "exact", 0.03]]);
    expect(q.rejected.map((r) => [r.workerId, r.reason])).toEqual([
      ["A", "over_budget"],
      ["C", "too_slow"],
    ]);
  });

  it("passes only selling workers to the matcher: probation changes no quote", async () => {
    const probation = snapshot("P", { fractal: 0.001 }, 1e-10, false);
    const strip = (q: Quote) => ({
      offers: q.offers.map((o) => [o.workerId, o.kind, o.priceAtomic, o.estSec]),
      counter: q.counterOffer && [q.counterOffer.workerId, q.counterOffer.priceAtomic],
      market: q.marketPriceUsd,
      rejected: q.rejected,
    });
    const before = await start();
    const withP = await start([...workers, probation]);
    for (const name of ["cpu-counter", "cpu-tight", "failover"] as const) {
      const a = Quote.parse(await (await before.quote(scenarioRequest(name))).json());
      const b = Quote.parse(await (await withP.quote(scenarioRequest(name))).json());
      expect(strip(b), name).toEqual(strip(a));
      expect(JSON.stringify(b)).not.toContain('"P"');
    }
  });

  it("refuses an invalid request and ignores a malformed run id", async () => {
    const { quote } = await start();
    expect((await quote({ workload: "fractal" })).status).toBe(400);
    const res = await quote(scenarioRequest("failover"), { "X-Pekkah-Run-Id": "../../x" });
    expect(Quote.parse(await res.json()).runId).toBeUndefined();
  });

  it("limits quotes to 30 a minute per client", async () => {
    const { quote } = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await quote({})).status);
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("offers", () => {
  it("expire 120 s after the quote, but stay payable for the 600 s window once the 402 is served", () => {
    let now = 1_000_000;
    const store = new OfferStore(() => now);
    const { quote, records } = buildQuote(
      scenarioRequest("cpu-tight"),
      {
        offers: [
          { workerId: "B", payTo: "addr_test1x", priceUsd: 0.03, priceAtomic: "30000", estSec: 11 },
        ],
        marketPriceUsd: 0.03,
        rejected: [],
      },
      { quoteId: "Q1", asset: DEFAULT_ASSET, now, nextId: () => "O1" },
    );
    store.add(records);
    const record = store.get("O1");
    if (!record) throw new Error("missing offer");
    expect(quote.offers[0]?.expiresAt).toBe(new Date(now + 120_000).toISOString());
    now += 119_000;
    expect(store.isPayable(record)).toBe(true);
    store.markRequired("O1");
    now += 2_000; // past 120 s, but the 402 was served
    expect(store.isPayable(record)).toBe(true);
    now += 600_000;
    expect(store.isPayable(record)).toBe(false);
    store.setState("O1", "claimed");
    store.sweep();
    expect(store.get("O1")).toBeDefined();
  });
});

describe("/ws/ui", () => {
  it("sends a snapshot first, then events and throttled worker updates", async () => {
    const bus = new EventBus(log);
    bus.emit({
      source: "market",
      type: "worker.online",
      data: { workerId: "B", name: "Worker B" },
    });
    let notify = () => {};
    const hub = new UiHub({
      bus,
      workers: () => workers,
      onWorkersChange: (listener) => {
        notify = listener;
        return () => {};
      },
      demo: () => ({ running: false, cooldownUntil: null, runsLeftToday: 40 }),
      log,
    });
    const server = createServer();
    hub.attach(server);
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    cleanup.push(() => {
      hub.close();
      server.close();
    });
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/ui`);
    const messages: UiMessage[] = [];
    ws.on("message", (data) => messages.push(UiMessage.parse(JSON.parse(data.toString()))));
    await new Promise((resolve) => ws.once("open", resolve));
    cleanup.push(() => ws.terminate());
    await new Promise((resolve) => setTimeout(resolve, 50));
    bus.emit({
      source: "market",
      type: "worker.offline",
      data: { workerId: "B", name: "Worker B" },
    });
    notify();
    notify();
    notify();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(messages.map((m) => m.type)).toEqual(["snapshot", "event", "workers"]);
    const [first] = messages;
    expect(first?.type === "snapshot" && first.recentEvents.map((e) => e.type)).toEqual([
      "worker.online",
    ]);
    expect(first?.type === "snapshot" && first.demo.runsLeftToday).toBe(40);
  });
});
