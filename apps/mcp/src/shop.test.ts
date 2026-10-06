import type { BuyRequest, BuyResult } from "@pekkah/buyer";
import {
  type CounterOffer,
  DEFAULT_ASSET,
  type JobEvent,
  MASUMI_LOCK_LABEL,
  MASUMI_RELEASED_LABEL,
  NETWORK,
  type Offer,
  type Quote,
  RUN_ID_HEADER,
  type WorkerSnapshot,
} from "@pekkah/protocol";
import { masumiEscrowAddress } from "@x402/cardano";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { escrowLines, NO_BUDGET_REFUSAL, overBudgetRefusal, Shop, type ShopDeps } from "./shop.js";

const bech = "pzry9x8gf2tvdw0s3jn54khce6mua7l";
const ADDR_A = `addr_test1q${bech.repeat(2).slice(0, 57)}`;
const ADDR_B = `addr_test1q${bech.repeat(2).slice(3, 60)}`;
const TX = "ab".repeat(32);
const LOCK_TX = "ef".repeat(32);
const SUBMIT_TX = "12".repeat(32);
const RELEASE_TX = "34".repeat(32);
const SHA = "cd".repeat(32);
const MARKET = "https://market.test";
const NOW = Date.parse("2026-10-07T10:00:00Z");
const later = (sec: number) => new Date(NOW + sec * 1000).toISOString();

const request = {
  workload: "image" as const,
  params: { prompt: "a lighthouse at dusk", seed: 7, size: 1024 as const, steps: 4 },
  constraints: { gpu: true, minVramGb: 16, deadlineSec: 60 },
  budget: { maxUsd: 0.03 },
};

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    offerId: "offerA",
    quoteId: "quote1",
    workerId: "A",
    workload: "image",
    priceUsd: 0.05,
    priceAtomic: "50000",
    asset: DEFAULT_ASSET,
    payTo: ADDR_A,
    estSec: 9.3,
    expiresAt: later(120),
    kind: "exact",
    ...overrides,
  };
}

/** Worker A over a $0.03 budget, back as the counter-offer; B and C have no GPU. */
function overBudgetQuote(overrides: Partial<CounterOffer> = {}): Quote {
  return {
    quoteId: "quote1",
    request,
    offers: [],
    counterOffer: {
      ...offer({ kind: "counter" }),
      reason: "No offer at or below $0.03. Market price $0.05. Next best: A at $0.05, about 9 s",
      ...overrides,
    },
    marketPriceUsd: 0.05,
    rejected: [
      { workerId: "A", reason: "over_budget", detail: "$0.05 > $0.03" },
      { workerId: "B", reason: "no_gpu", detail: "No GPU" },
    ],
    expiresAt: later(120),
  };
}

function fitsQuote(): Quote {
  return {
    quoteId: "quote2",
    request: { ...request, budget: { maxUsd: 0.1 } },
    offers: [offer()],
    marketPriceUsd: 0.05,
    rejected: [{ workerId: "B", reason: "no_gpu", detail: "No GPU" }],
    expiresAt: later(120),
  };
}

const workerA: WorkerSnapshot = {
  workerId: "A",
  name: "Worker A",
  payTo: ADDR_A,
  hardware: {
    cpuModel: "Xeon",
    vcpus: 8,
    memGb: 31,
    gpu: { name: "NVIDIA RTX 4000 Ada Generation", vramGb: 20, driver: "580" },
  },
  prices: [{ workload: "image", usd: 0.05, atomic: "50000" }],
  status: "online",
  calibration: { image: { secImage1024x4: 6.9, verified: false, at: later(-600) } },
  warm: ["image"],
  lastSeenAt: later(0),
  selling: true,
  escrowSeller: true,
};
const workerB: WorkerSnapshot = {
  ...workerA,
  workerId: "B",
  name: "Worker B",
  payTo: ADDR_B,
  hardware: { cpuModel: "EPYC", vcpus: 8, memGb: 16 },
  escrowSeller: false,
};

function tinyPng(): Buffer {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([200, 80, 40, 255], i);
  return PNG.sync.write(png);
}

const paidBody = {
  jobId: "job1",
  workerId: "A",
  workload: "image",
  durationMs: 6900,
  sha256: SHA,
  mime: "image/png",
  resultUrl: "/api/results/job1",
  txHash: TX,
};
const paid: Partial<BuyResult> = {
  status: 200,
  txHash: TX,
  settle: { success: true, transaction: TX, network: NETWORK } as BuyResult["settle"],
  body: paidBody,
};

function ev(type: string, data: unknown, extra: Partial<JobEvent> = {}): JobEvent {
  return {
    id: `e${Math.random().toString(36).slice(2)}`,
    ts: later(0),
    source: "chain",
    type,
    data,
    ...extra,
  } as JobEvent;
}

const locked = ev("escrow.locked", {
  txHash: LOCK_TX,
  escrowAddress: masumiEscrowAddress(NETWORK),
  sellerAddress: ADDR_A,
  amountAtomic: "50000",
  asset: DEFAULT_ASSET,
  collateralLovelace: "4003990",
  inputHash: "aa".repeat(32),
  payByTime: String(NOW + 600_000),
  submitResultTime: String(NOW + 960_000),
  unlockTime: String(NOW + 1_890_000),
  externalDisputeUnlockTime: String(NOW + 2_820_000),
  explorerUrl: `https://preprod.cardanoscan.io/transaction/${LOCK_TX}`,
});
const completed = ev(
  "job.completed",
  { workerId: "A", durationMs: 6900, sha256: SHA, mime: "image/png" },
  { source: "worker", jobId: "job1" },
);
const submitted = ev("escrow.result_submitted", {
  lockTxHash: LOCK_TX,
  txHash: SUBMIT_TX,
  resultHash: SHA,
  explorerUrl: `https://preprod.cardanoscan.io/transaction/${SUBMIT_TX}`,
});
const released = ev("escrow.released", {
  lockTxHash: LOCK_TX,
  txHash: RELEASE_TX,
  sellerAddress: ADDR_A,
  buyerAddress: ADDR_B,
  amountAtomic: "50000",
  asset: DEFAULT_ASSET,
  collateralReturnLovelace: "4003990",
  explorerUrl: `https://preprod.cardanoscan.io/transaction/${RELEASE_TX}`,
});

function setup(o: { quotes: Quote[]; buys?: Partial<BuyResult>[]; runEvents?: JobEvent[] }) {
  const calls = {
    quote: [] as { body: unknown; runId?: string }[],
    buy: [] as BuyRequest[],
    events: [] as { type: string; data: Record<string, unknown>; runId: string }[],
  };
  let clock = NOW;
  let ids = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === `${MARKET}/api/quote`) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.quote.push({ body: JSON.parse(String(init?.body)), runId: headers[RUN_ID_HEADER] });
      return new Response(JSON.stringify(o.quotes.shift()));
    }
    if (url === `${MARKET}/api/workers`) return new Response(JSON.stringify([workerA, workerB]));
    if (url.startsWith(`${MARKET}/api/runs/`)) {
      const runId = url.split("/")[5] ?? "";
      if (!o.runEvents) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ runId, events: o.runEvents }));
    }
    if (url === `${MARKET}/api/results/job1`) {
      return new Response(tinyPng(), { headers: { "content-type": "image/png" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const deps: ShopDeps = {
    marketUrl: MARKET,
    asset: DEFAULT_ASSET,
    fetch: fetchImpl,
    newRunId: () => `run${++ids}`,
    client: () => "Claude via MCP",
    capUsd: 0.1,
    now: () => clock,
    waitMs: 2_000,
    clock: (ms) => new Date(ms).toISOString().slice(11, 16),
    buyer: {
      idle: async () => {},
      balance: async () => ({ lovelace: "40000000", assetAtomic: "5000000" }),
      buy: async (req) => {
        calls.buy.push(req);
        return { status: 500, body: null, durationMs: 1, ...o.buys?.shift() } as BuyResult;
      },
    },
    emit: async (type, data, ids) => {
      calls.events.push({ type, data: data as Record<string, unknown>, runId: ids.runId });
    },
  };
  return {
    shop: new Shop(deps),
    calls,
    tick: (sec: number) => {
      clock += sec * 1000;
    },
  };
}

const textOf = (r: { content: { type: string; text?: string }[] } | null) =>
  (r?.content ?? []).map((c) => c.text ?? "").join("\n");

describe("pekkah_quote", () => {
  it("starts a custom run for Claude, then hints to ask when nothing fits the budget", async () => {
    const { shop, calls } = setup({ quotes: [overBudgetQuote()] });
    const result = await shop.quote({ prompt: "a lighthouse at dusk", budgetUsd: 0.03 });
    const t = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(calls.events.map((e) => e.type)).toEqual(["run.started", "agent.balance"]);
    expect(calls.events[0]?.data).toMatchObject({ scenario: "custom", client: "Claude via MCP" });
    expect(calls.quote[0]?.runId).toBe("run1");
    expect(calls.quote[0]?.body).toMatchObject({
      workload: "image",
      constraints: { gpu: true, minVramGb: 16, deadlineSec: 60 },
      budget: { maxUsd: 0.03 },
    });
    expect(t).toContain("Quote for task run1");
    expect(t).toContain("Budget: $0.03.");
    expect(t).toContain("offerId offerA: worker A, NVIDIA RTX 4000 Ada Generation");
    expect(t).toContain("(reported by the machine)");
    expect(t).toContain("Masumi escrow available");
    expect(t).toContain("valid 120 s more");
    expect(t).toContain("- B: No GPU");
    expect(t).toContain(
      "Hint: nothing within $0.03: ask your human before paying $0.05 (worker A).",
    );
  });

  it("says the offer fits the budget, and that no budget means asking first", async () => {
    const fits = setup({ quotes: [fitsQuote()] });
    expect(textOf(await fits.shop.quote({ prompt: "x", budgetUsd: 0.1 }))).toContain(
      "Hint: fits the budget: offerId offerA, $0.05 on worker A. Buy it without asking.",
    );
    const none = setup({ quotes: [fitsQuote()] });
    const t = textOf(await none.shop.quote({ prompt: "x" }));
    expect(t).toContain("Budget: none given yet.");
    expect(t).toContain("Hint: no budget given: ask your human for one before buying");
    // Without a budget the market is asked up to my agent's cap.
    expect(none.calls.quote[0]?.body).toMatchObject({ budget: { maxUsd: 0.1 } });
  });

  it("continues a task with its runId, without starting a new run", async () => {
    const { shop, calls } = setup({ quotes: [overBudgetQuote(), fitsQuote()] });
    await shop.quote({ prompt: "x", budgetUsd: 0.03 });
    await shop.quote({ prompt: "x", budgetUsd: 0.1, runId: "run1" });
    expect(calls.quote.map((q) => q.runId)).toEqual(["run1", "run1"]);
    expect(calls.events.filter((e) => e.type === "run.started")).toHaveLength(1);
  });

  it("closes an open task that bought nothing when a new one starts", async () => {
    const { shop, calls } = setup({ quotes: [overBudgetQuote(), fitsQuote()] });
    await shop.quote({ prompt: "x", budgetUsd: 0.03 });
    await shop.quote({ prompt: "y", budgetUsd: 0.1 });
    const failed = calls.events.find((e) => e.type === "run.failed");
    expect(failed?.runId).toBe("run1");
    expect(calls.events.filter((e) => e.type === "run.started").map((e) => e.runId)).toEqual([
      "run1",
      "run2",
    ]);
  });
});

describe("pekkah_buy", () => {
  const reason = "Only worker A has a GPU, and my human said yes to $0.05.";

  it("refuses an offer above the budget without overBudgetApproved, and buys nothing", async () => {
    const { shop, calls } = setup({ quotes: [overBudgetQuote()] });
    await shop.quote({ prompt: "x", budgetUsd: 0.03 });
    const started = shop.buy({ offerId: "offerA", maxUsd: 0.05, reason });
    expect("refused" in started).toBe(true);
    const t = "refused" in started ? textOf(started.refused) : "";
    expect(t).toBe(overBudgetRefusal(0.03, "50000"));
    expect(t).toContain("This is above the $0.03 budget your human gave. Ask them first.");
    expect(calls.buy).toHaveLength(0);
    expect(calls.events.map((e) => e.type)).not.toContain("agent.decision");
  });

  it("after my human's yes, locks in escrow and records my agent's statement", async () => {
    const { shop, calls } = setup({
      quotes: [overBudgetQuote()],
      buys: [paid],
      runEvents: [completed, locked],
    });
    await shop.quote({ prompt: "x", budgetUsd: 0.03 });
    const started = shop.buy({ offerId: "offerA", maxUsd: 0.05, overBudgetApproved: true, reason });
    if (!("runId" in started)) throw new Error(textOf(started.refused));
    const result = await shop.result(started.runId);
    expect(result?.isError).toBeUndefined();
    expect(result?.content[0]?.type).toBe("image");
    const t = textOf(result);
    expect(t).toContain(
      "Locked $0.05 in test tUSDM in Masumi escrow, with worker A as the seller, after the job delivered.",
    );
    expect(t).toContain(`https://preprod.cardanoscan.io/transaction/${TX}`);
    expect(t).toContain("1. Locked in escrow: 0.05 tUSDM plus 4.00399 tADA of collateral.");
    expect(t).toContain(MASUMI_LOCK_LABEL);
    expect(t).not.toMatch(/\breleased\b|\bpaid\b/i);

    const buy = calls.buy[0];
    expect(buy?.url).toBe(`${MARKET}/api/escrow-jobs/offerA`);
    expect(buy?.headers?.[RUN_ID_HEADER]).toBe("run1");
    // The 402 must lock exactly this: at the escrow, worker A as seller, bound to the quote.
    expect(buy?.expect).toEqual({
      transferMethod: "masumi",
      payTo: masumiEscrowAddress(NETWORK),
      seller: ADDR_A,
      parameters: request,
      amountAtomic: "50000",
      asset: DEFAULT_ASSET,
    });
    const decision = calls.events.find((e) => e.type === "agent.decision");
    expect(decision?.data).toMatchObject({
      kind: "counter",
      reasons: [reason],
      overBudget: { budgetUsd: 0.03, priceUsd: 0.05 },
    });
    expect(calls.events.at(-1)?.type).toBe("run.completed");
  });

  it("buys without asking when the offer fits the budget, with no over-budget statement", async () => {
    const { shop, calls } = setup({ quotes: [fitsQuote()], buys: [paid], runEvents: [locked] });
    await shop.quote({ prompt: "x", budgetUsd: 0.1 });
    const started = shop.buy({ offerId: "offerA", maxUsd: 0.1, reason: "It fits." });
    expect("runId" in started).toBe(true);
    if ("runId" in started) await shop.result(started.runId);
    const decision = calls.events.find((e) => e.type === "agent.decision");
    expect(decision?.data).toMatchObject({ kind: "exact", reasons: ["It fits."] });
    expect(decision?.data.overBudget).toBeUndefined();
    expect(calls.buy).toHaveLength(1);
  });

  it("pays a worker directly when escrow is off", async () => {
    const { shop, calls } = setup({ quotes: [fitsQuote()], buys: [paid] });
    await shop.quote({ prompt: "x", budgetUsd: 0.1 });
    const started = shop.buy({ offerId: "offerA", maxUsd: 0.1, escrow: false, reason: "x" });
    if (!("runId" in started)) throw new Error("refused");
    const t = textOf(await shop.result(started.runId));
    expect(calls.buy[0]?.url).toBe(`${MARKET}/api/jobs/offerA`);
    expect(calls.buy[0]?.expect).toEqual({
      payTo: ADDR_A,
      amountAtomic: "50000",
      asset: DEFAULT_ASSET,
    });
    expect(t).toContain("Paid $0.05 in test tUSDM to worker A, the worker that ran the job");
    expect(t).not.toContain("escrow");
  });

  it("refuses without a budget, above maxUsd, offers it didn't quote, and escrow nobody sells", async () => {
    const noBudget = setup({ quotes: [fitsQuote()] });
    await noBudget.shop.quote({ prompt: "x" });
    const a = noBudget.shop.buy({ offerId: "offerA", maxUsd: 0.1, reason: "x" });
    expect("refused" in a && textOf(a.refused)).toBe(NO_BUDGET_REFUSAL);

    const s = setup({
      quotes: [
        {
          ...fitsQuote(),
          offers: [offer(), offer({ offerId: "offerB", workerId: "B", payTo: ADDR_B })],
        },
      ],
    });
    await s.shop.quote({ prompt: "x", budgetUsd: 0.1 });
    const ceiling = s.shop.buy({ offerId: "offerA", maxUsd: 0.04, reason: "x" });
    expect("refused" in ceiling && textOf(ceiling.refused)).toContain(
      "above the $0.04 ceiling in maxUsd",
    );
    const unknown = s.shop.buy({ offerId: "nope", maxUsd: 0.1, reason: "x" });
    expect("refused" in unknown && textOf(unknown.refused)).toContain("didn't quote offer nope");
    const escrowB = s.shop.buy({ offerId: "offerB", maxUsd: 0.1, escrow: true, reason: "x" });
    expect("refused" in escrowB && textOf(escrowB.refused)).toContain(
      "Worker B doesn't sell through Masumi escrow",
    );
    expect(s.calls.buy).toHaveLength(0);
  });

  it("quotes an expired offer again and buys only from the same worker", async () => {
    const { shop, calls, tick } = setup({
      quotes: [overBudgetQuote(), overBudgetQuote({ offerId: "offerA2", expiresAt: later(400) })],
      buys: [paid],
      runEvents: [locked],
    });
    await shop.quote({ prompt: "x", budgetUsd: 0.03 });
    tick(200);
    const started = shop.buy({ offerId: "offerA", maxUsd: 0.05, overBudgetApproved: true, reason });
    if (!("runId" in started)) throw new Error("refused");
    await shop.result(started.runId);
    expect(calls.quote).toHaveLength(2);
    expect(calls.quote[1]?.body).toEqual(request);
    expect(calls.buy.map((b) => b.offerId)).toEqual(["offerA2"]);
    expect(calls.events.map((e) => e.type)).toContain("agent.reroute");
  });

  it("buys nothing when the re-quote has no offer from that worker, or a higher approved price", async () => {
    const gone = setup({
      quotes: [overBudgetQuote(), { ...overBudgetQuote(), counterOffer: undefined }],
    });
    await gone.shop.quote({ prompt: "x", budgetUsd: 0.03 });
    gone.tick(200);
    const a = gone.shop.buy({ offerId: "offerA", maxUsd: 0.1, overBudgetApproved: true, reason });
    if (!("runId" in a)) throw new Error("refused");
    const t = textOf(await gone.shop.result(a.runId));
    expect(t).toContain("Worker A no longer offers this job; nothing was charged.");
    expect(gone.calls.buy).toHaveLength(0);
    expect(gone.calls.events.at(-1)?.type).toBe("run.failed");

    const pricier = setup({
      quotes: [
        overBudgetQuote(),
        overBudgetQuote({ offerId: "offerA2", priceUsd: 0.07, priceAtomic: "70000" }),
      ],
    });
    await pricier.shop.quote({ prompt: "x", budgetUsd: 0.03 });
    pricier.tick(200);
    const b = pricier.shop.buy({
      offerId: "offerA",
      maxUsd: 0.1,
      overBudgetApproved: true,
      reason,
    });
    if (!("runId" in b)) throw new Error("refused");
    expect(textOf(await pricier.shop.result(b.runId))).toContain(
      "now asks $0.07, more than the $0.05 your human approved",
    );
    expect(pricier.calls.buy).toHaveLength(0);
  });

  it("reports a failed job as cancelled, with nothing charged", async () => {
    const { shop, calls } = setup({
      quotes: [fitsQuote()],
      buys: [{ status: 502, txHash: TX, body: { error: "job_failed" } }],
    });
    await shop.quote({ prompt: "x", budgetUsd: 0.1 });
    const started = shop.buy({ offerId: "offerA", maxUsd: 0.1, reason: "x" });
    if (!("runId" in started)) throw new Error("refused");
    const result = await shop.result(started.runId);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain("nothing was charged");
    expect(calls.events.at(-1)).toMatchObject({ type: "run.failed", runId: "run1" });
  });
});

describe("pekkah_result", () => {
  it("reads a run it didn't buy from the market", async () => {
    const receipt = ev(
      "receipt.issued",
      {
        receipt: {
          txHash: TX,
          network: NETWORK,
          payTo: ADDR_A,
          amountAtomic: "50000",
          asset: DEFAULT_ASSET,
          transferMethod: "default",
          explorerUrl: `https://preprod.cardanoscan.io/transaction/${TX}`,
          settledAt: later(0),
        },
        resultUrl: "/api/results/job1",
      },
      { source: "market", jobId: "job1" },
    );
    const { shop } = setup({ quotes: [], runEvents: [completed, receipt] });
    const t = textOf(await shop.result("01OLDRUN"));
    expect(t).toContain("Paid $0.05 in test tUSDM to worker A");
    expect(t).toContain("Made in 6.9 s on worker A");
  });

  it("says so when the market doesn't have the run", async () => {
    const { shop } = setup({ quotes: [] });
    const result = await shop.result("01NOPE");
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain("keeps the last 30 runs");
  });
});

describe("escrowLines", () => {
  const o = { now: NOW + 600_000, clock: (ms: number) => new Date(ms).toISOString().slice(11, 16) };

  it("says locked in escrow, with the unlock time, until the release exists", () => {
    const t = escrowLines([completed, locked, submitted], o).join("\n");
    expect(t).toContain("2. Result hash submitted on chain, and it matches the delivered result.");
    expect(t).toContain("3. Unlock: 10:31 (in 22 min).");
    expect(t).toContain("4. Waiting for the unlock: then the seller can collect.");
    expect(t).toContain(MASUMI_LOCK_LABEL);
    expect(t).not.toMatch(/\breleased\b/i);
  });

  it("shows the release and the collateral back once escrow.released exists", () => {
    const t = escrowLines([completed, locked, submitted, released], o).join("\n");
    expect(t).toContain(
      `4. Released to the seller: Tx https://preprod.cardanoscan.io/transaction/${RELEASE_TX}. The buyer's 4.00399 tADA of collateral came back.`,
    );
    expect(t).toContain(MASUMI_RELEASED_LABEL);
  });

  it("doesn't claim a match when the result hash differs", () => {
    const other = { ...submitted, data: { ...submitted.data, resultHash: "99".repeat(32) } };
    const t = escrowLines([completed, locked, other as JobEvent], o).join("\n");
    expect(t).toContain("2. Result hash submitted on chain. Tx");
    expect(t).not.toContain("matches");
  });
});
