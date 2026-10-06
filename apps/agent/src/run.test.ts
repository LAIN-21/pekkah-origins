import {
  DEFAULT_ASSET,
  type JobResultBody,
  NETWORK,
  type Offer,
  type Quote,
  scenarioRequest,
} from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import type { MarketClient } from "./market.js";
import { runScenario } from "./run.js";

const TX = "c".repeat(64);
const offer = (offerId: string): Offer => ({
  offerId,
  quoteId: "Q",
  workerId: "B",
  workload: "fractal",
  priceUsd: 0.03,
  priceAtomic: "30000",
  asset: DEFAULT_ASSET,
  payTo: `addr_test1vq${"q".repeat(51)}`,
  estSec: 9,
  expiresAt: new Date().toISOString(),
  kind: "exact",
});
const quote = (offerId: string): Quote => ({
  quoteId: "Q",
  request: scenarioRequest("cpu-tight"),
  offers: [offer(offerId)],
  marketPriceUsd: 0.03,
  rejected: [],
  expiresAt: new Date().toISOString(),
});
const job: JobResultBody = {
  jobId: "01JOB",
  workerId: "B",
  workload: "fractal",
  durationMs: 7000,
  sha256: "d".repeat(64),
  mime: "image/png",
  resultUrl: "/api/results/01JOB",
  txHash: TX,
};

/** A market and a buyer that answer each purchase with the next status in `statuses`. */
function fakes(statuses: number[]) {
  const events: { type: string; data: unknown }[] = [];
  const bought: string[] = [];
  let quotes = 0;
  const market = {
    url: "https://market.test",
    quote: async () => quote(`O${++quotes}`),
    event: async (type: string, data: unknown) => void events.push({ type, data }),
    result: async () => Buffer.from("png"),
  } as unknown as MarketClient;
  const buyer = {
    address: "addr_test1buyer",
    balance: async () => ({ lovelace: "1", assetAtomic: "1" }),
    idle: async () => {},
    waitForTx: async () => ({ found: true }),
    buy: async (request: { offerId?: string }) => {
      bought.push(request.offerId ?? "");
      const status = statuses.shift() ?? 500;
      return status === 200
        ? {
            status,
            body: job,
            txHash: TX,
            settle: { success: true, transaction: TX, network: NETWORK },
            durationMs: 1,
          }
        : { status, body: { error: "offer_not_found" }, durationMs: 1 };
    },
  };
  const run = () =>
    runScenario({
      scenario: "cpu-tight",
      runId: "01RUN",
      buyer: buyer as never,
      market,
      print: () => {},
    });
  return { run, events, bought };
}

describe("runScenario", () => {
  it("re-quotes when the offer is gone, and pays the new one", async () => {
    const f = fakes([404, 200]);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ ok: true, txHash: TX, workerId: "B" });
    expect(f.bought).toEqual(["O1", "O2"]);
    const reroute = f.events.find((e) => e.type === "agent.reroute");
    expect(reroute?.data).toMatchObject({ excluded: [] });
    expect(f.events.at(-1)?.type).toBe("run.completed");
  });

  it("still fails over once after a re-quote, while a quote is left", async () => {
    const f = fakes([404, 502, 200]);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ ok: true, txHash: TX });
    expect(f.bought).toEqual(["O1", "O2", "O3"]);
    const reroutes = f.events.filter((e) => e.type === "agent.reroute").map((e) => e.data);
    expect(reroutes).toMatchObject([{ excluded: [] }, { excluded: ["B"] }]);
  });

  it("stops after three quotes, so a run always ends", async () => {
    const f = fakes([410, 409, 404, 200]);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ ok: false, reason: "the market answered 404" });
    expect(f.bought).toEqual(["O1", "O2", "O3"]);
    expect(f.events.at(-1)?.type).toBe("run.failed");
  });
});
