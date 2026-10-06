import type { BuyRequest, BuyResult } from "@pekkah/buyer";
import {
  DEFAULT_ASSET,
  type Offer,
  type Quote,
  RUN_ID_HEADER,
  type WorkerSnapshot,
} from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import { choose, type Deps, generateImage, marketText, PurchaseBook } from "./pekkah.js";

const ADDR_A = `addr_test1q${"pzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2).slice(0, 57)}`;
const TX = "ab".repeat(32);
const SHA = "cd".repeat(32);
const MARKET = "https://market.test";
const now = new Date().toISOString();

const request = {
  workload: "image" as const,
  params: { prompt: "a lighthouse at dusk", seed: 7, size: 1024 as const, steps: 4 },
  constraints: { gpu: true, minVramGb: 16, deadlineSec: 60 },
  budget: { maxUsd: 0.05 },
};

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    offerId: "offer1",
    quoteId: "quote1",
    workerId: "A",
    workload: "image",
    priceUsd: 0.05,
    priceAtomic: "50000",
    asset: DEFAULT_ASSET,
    payTo: ADDR_A,
    estSec: 9.3,
    expiresAt: now,
    kind: "exact",
    ...overrides,
  };
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    quoteId: "quote1",
    request,
    offers: [offer()],
    marketPriceUsd: 0.05,
    rejected: [{ workerId: "B", reason: "no_gpu", detail: "No GPU" }],
    expiresAt: now,
    ...overrides,
  };
}

const worker: WorkerSnapshot = {
  workerId: "A",
  name: "Worker A",
  payTo: ADDR_A,
  hardware: {
    cpuModel: "Xeon",
    vcpus: 8,
    memGb: 31,
    gpu: { name: "NVIDIA RTX 4000 Ada Generation", vramGb: 20, driver: "580" },
  },
  prices: [
    { workload: "fractal", usd: 0.05, atomic: "50000" },
    { workload: "image", usd: 0.05, atomic: "50000" },
  ],
  status: "online",
  calibration: {
    fractal: {
      overheadSec: 1,
      calibSec: 1.5,
      secPerIter: 0.001,
      verified: true,
      challenge: 3,
      at: now,
    },
    image: { secImage1024x4: 6.9, verified: false, at: now },
  },
  warm: ["fractal", "image"],
  lastSeenAt: now,
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function setup(quotes: Quote[], buys: Partial<BuyResult>[]) {
  const calls = {
    quote: [] as RequestInit[],
    buy: [] as BuyRequest[],
    idle: 0,
    events: [] as string[],
  };
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === `${MARKET}/api/quote`) {
      calls.quote.push(init ?? {});
      return new Response(JSON.stringify(quotes.shift()));
    }
    if (url === `${MARKET}/api/results/job1`)
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    if (url === `${MARKET}/api/workers`) return new Response(JSON.stringify([worker]));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const deps: Deps = {
    marketUrl: MARKET,
    asset: DEFAULT_ASSET,
    fetch: fetchImpl,
    newRunId: () => "run1",
    buyer: {
      idle: async () => {
        calls.idle += 1;
      },
      buy: async (req) => {
        calls.buy.push(req);
        return { status: 500, body: null, durationMs: 1, ...buys.shift() } as BuyResult;
      },
    },
    emit: async (type) => {
      calls.events.push(type);
    },
  };
  return { deps, calls };
}

const paid: Partial<BuyResult> = {
  status: 200,
  txHash: TX,
  settle: { success: true, transaction: TX, network: "cardano:preprod" } as BuyResult["settle"],
  body: {
    jobId: "job1",
    workerId: "A",
    workload: "image",
    durationMs: 6900,
    sha256: SHA,
    mime: "image/png",
    resultUrl: "/api/results/job1",
    txHash: TX,
  },
};

describe("pekkah_generate_image", () => {
  it("buys the exact offer, then returns the image and a receipt with the tx link", async () => {
    const { deps, calls } = setup([quote()], [paid]);
    const result = await generateImage({ prompt: "a lighthouse at dusk", maxUsd: 0.05 }, deps);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });
    const receipt = result.content[1];
    expect(receipt?.type === "text" && receipt.text).toContain(
      `https://preprod.cardanoscan.io/transaction/${TX}`,
    );
    // The 402 must match the offer my agent took: worker A's address, $0.05, tUSDM.
    expect(calls.buy[0]?.expect).toEqual({
      payTo: ADDR_A,
      amountAtomic: "50000",
      asset: DEFAULT_ASSET,
    });
    expect(calls.buy[0]?.url).toBe(`${MARKET}/api/jobs/offer1`);
    expect(calls.buy[0]?.headers?.[RUN_ID_HEADER]).toBe("run1");
    const quoteHeaders = (calls.quote[0]?.headers ?? {}) as Record<string, string>;
    expect(quoteHeaders[RUN_ID_HEADER]).toBe("run1");
    expect(calls.idle).toBe(1);
    expect(calls.events).toEqual(["run.started", "agent.decision", "run.completed"]);
  });

  it("reports a failed job as cancelled, with nothing charged", async () => {
    const { deps, calls } = setup(
      [quote()],
      [{ status: 502, txHash: TX, body: { error: "job_failed" } }],
    );
    const result = await generateImage({ prompt: "x", maxUsd: 0.05 }, deps);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain(
      "nothing was charged",
    );
    expect(calls.events.at(-1)).toBe("run.failed");
  });

  it("keeps the receipt when the image download fails after paying", async () => {
    const { deps } = setup([quote()], [paid]);
    const market = deps.fetch as typeof fetch;
    deps.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/api/results/job1")) throw new Error("socket hang up");
      return market(input, init);
    }) as typeof fetch;
    const result = await generateImage({ prompt: "x", maxUsd: 0.05 }, deps);
    expect(result.isError).toBeUndefined();
    const line = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(line).toContain(`https://preprod.cardanoscan.io/transaction/${TX}`);
    expect(line).toContain("The image couldn't be fetched: socket hang up.");
  });

  it("asks again once when the offer was gone before paying", async () => {
    const { deps, calls } = setup(
      [quote(), quote()],
      [{ status: 409, body: { error: "offer_closed" } }, paid],
    );
    const result = await generateImage({ prompt: "x", maxUsd: 0.05 }, deps);
    expect(result.isError).toBeUndefined();
    expect(calls.quote).toHaveLength(2);
    expect(calls.buy).toHaveLength(2);
  });

  it("buys nothing when the only offer is above maxUsd", async () => {
    const counter = {
      ...offer({ priceUsd: 0.08, priceAtomic: "80000", kind: "counter" }),
      reason: "No offer at or below $0.05",
    };
    const { deps, calls } = setup([quote({ offers: [], counterOffer: counter })], []);
    const result = await generateImage({ prompt: "x", maxUsd: 0.05 }, deps);
    expect(result.isError).toBe(true);
    expect(calls.buy).toHaveLength(0);
    expect(calls.events).toEqual(["run.started", "agent.decision", "run.failed"]);
  });
});

describe("choose", () => {
  it("takes a counter-offer within the limit and the deadline", () => {
    const counter = {
      ...offer({ priceUsd: 0.04, priceAtomic: "40000", kind: "counter" }),
      reason: "Next best: A",
    };
    expect(choose(quote({ offers: [], counterOffer: counter }), 0.05).kind).toBe("counter");
  });

  it("declines when no worker can do the job", () => {
    expect(choose(quote({ offers: [] }), 0.1).kind).toBe("declined");
  });
});

describe("pekkah_market", () => {
  it("lists hardware, prices and measured speed", async () => {
    const { deps } = setup([], []);
    const result = await marketText(deps);
    const line = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(line).toContain(
      "Worker A (A), online: NVIDIA RTX 4000 Ada Generation, 20 GB VRAM, 8 vCPU",
    );
    expect(line).toContain("image $0.05");
    expect(line).toContain("CPU render measured 1.5 s (answer checked)");
    expect(line).toContain("1024² image in 6.9 s (timed)");
  });
});

describe("PurchaseBook", () => {
  it("returns early with a run id, then hands over the image on a later call", async () => {
    const { deps } = setup([quote()], []);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.buyer.buy = async () => {
      await gate;
      return { durationMs: 1, ...paid } as BuyResult;
    };
    const book = new PurchaseBook(deps, 50);
    const runId = book.start({ prompt: "a lighthouse", maxUsd: 0.05 });
    expect(runId).toBe("run1");
    expect(await book.wait(runId)).toBeNull();
    release();
    const result = await book.wait(runId);
    expect(result?.content[0]?.type).toBe("image");
    expect(book.has("someone-else")).toBe(false);
  });

  it("never evicts a purchase that is still in flight", async () => {
    const { deps } = setup([quote(), quote(), quote()], []);
    let n = 0;
    deps.newRunId = () => `run${++n}`;
    let calls = 0;
    deps.buyer.buy = async () => {
      calls += 1;
      // The first purchase never finishes; the others settle at once.
      if (calls === 1) return new Promise<BuyResult>(() => {});
      return { durationMs: 1, ...paid } as BuyResult;
    };
    const book = new PurchaseBook(deps, 1000, 1);
    const pending = book.start({ prompt: "a", maxUsd: 0.05 });
    await new Promise((r) => setTimeout(r, 20));
    const finished = book.start({ prompt: "b", maxUsd: 0.05 });
    expect((await book.wait(finished))?.content[0]?.type).toBe("image");
    const latest = book.start({ prompt: "c", maxUsd: 0.05 });
    expect(book.has(pending)).toBe(true);
    expect(book.has(finished)).toBe(false);
    expect(book.has(latest)).toBe(true);
  });

  it("turns a crash into an error result instead of a rejected promise", async () => {
    const { deps } = setup([quote()], []);
    deps.buyer.buy = async () => {
      throw new Error("blockfrost down");
    };
    const book = new PurchaseBook(deps, 1000);
    const result = await book.wait(book.start({ prompt: "x", maxUsd: 0.05 }));
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.type === "text" && result.content[0].text).toContain(
      "blockfrost down",
    );
  });
});
