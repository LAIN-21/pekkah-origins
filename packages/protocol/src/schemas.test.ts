import { describe, expect, it } from "vitest";
import { DemoRunRequest, DevDispatchRequest } from "./api.js";
import { DEFAULT_ASSET, explorerTxUrl, HELLO_LIMITS } from "./constants.js";
import {
  AgentEventsBody,
  CHAIN_EVENT_TYPES,
  EVENT_TYPES,
  JobEvent,
  WORKER_EVENT_TYPES,
} from "./events.js";
import { ELIGIBILITY_ORDER, Offer, PaymentReceipt, Quote, RejectionReason } from "./market.js";
import { AssetId, CardanoAddress } from "./primitives.js";
import { ComputeRequest } from "./request.js";
import {
  isPublicScenario,
  isScenarioName,
  PUBLIC_SCENARIOS,
  RunScenario,
  SCENARIOS,
  ScenarioName,
  scenarioRequest,
} from "./scenarios.js";
import { WorkerSnapshot } from "./worker.js";
import { FractalParams, IMAGE_PROMPTS, ImageParams } from "./workloads.js";
import { UiMessage } from "./ws-ui.js";
import { HelloMsg, MarketToWorker, WorkerToMarket } from "./ws-worker.js";

const TX = "a".repeat(64);
const SHA = "b".repeat(64);
// Syntactically valid preprod addresses (bech32 charset); not real wallets.
const ADDR_A = `addr_test1${"q".repeat(98)}`;
const ADDR_ESCROW = `addr_test1${"w".repeat(53)}`;
const NOW = "2026-10-06T12:00:00.000Z";

const offer = {
  offerId: "01J9OFFER",
  quoteId: "01J9QUOTE",
  workerId: "C",
  workload: "fractal",
  priceUsd: 0.02,
  priceAtomic: "20000",
  asset: DEFAULT_ASSET,
  payTo: ADDR_A,
  estSec: 31,
  expiresAt: NOW,
  kind: "counter",
} as const;

describe("workload params", () => {
  it("fills fractal defaults and checks the calib challenge rule", () => {
    expect(FractalParams.parse({ preset: "tiny" })).toEqual({
      preset: "tiny",
      palette: "ember",
      format: "png",
    });
    expect(FractalParams.safeParse({ preset: "calib", challenge: 7 }).success).toBe(true);
    expect(FractalParams.safeParse({ preset: "calib" }).success).toBe(false);
    expect(FractalParams.safeParse({ preset: "calib", challenge: 8 }).success).toBe(false);
    expect(FractalParams.safeParse({ preset: "hd-fast", challenge: 1 }).success).toBe(false);
    expect(FractalParams.safeParse({ preset: "hd-fast", extra: "x" }).success).toBe(false);
  });

  it("bounds image params", () => {
    const ok = { prompt: "a fox", seed: 7, size: 1024, steps: 4 };
    expect(ImageParams.safeParse(ok).success).toBe(true);
    expect(ImageParams.safeParse({ ...ok, prompt: "" }).success).toBe(false);
    expect(ImageParams.safeParse({ ...ok, prompt: "   " }).success).toBe(false);
    expect(ImageParams.safeParse({ ...ok, prompt: "x".repeat(301) }).success).toBe(false);
    expect(ImageParams.safeParse({ ...ok, prompt: "x".repeat(300) }).success).toBe(true);
    expect(ImageParams.safeParse({ ...ok, size: 512 }).success).toBe(false);
    expect(ImageParams.safeParse({ ...ok, steps: 5 }).success).toBe(false);
    expect(ImageParams.safeParse({ ...ok, seed: 1.5 }).success).toBe(false);
  });

  it("keeps every public prompt within the limit", () => {
    expect(IMAGE_PROMPTS).toHaveLength(5);
    for (const prompt of IMAGE_PROMPTS) {
      expect(ImageParams.safeParse({ prompt, seed: 7, size: 1024, steps: 4 }).success).toBe(true);
    }
  });
});

describe("ComputeRequest", () => {
  const base = scenarioRequest("cpu-tight");

  it("bounds the deadline to 5..120 s", () => {
    for (const deadlineSec of [4, 121, 30.5]) {
      const r = { ...base, constraints: { ...base.constraints, deadlineSec } };
      expect(ComputeRequest.safeParse(r).success).toBe(false);
    }
    for (const deadlineSec of [5, 120]) {
      const r = { ...base, constraints: { ...base.constraints, deadlineSec } };
      expect(ComputeRequest.safeParse(r).success).toBe(true);
    }
  });

  it("pairs params with the workload", () => {
    const wrong = { ...base, workload: "image" };
    expect(ComputeRequest.safeParse(wrong).success).toBe(false);
    expect(ComputeRequest.safeParse({ ...base, budget: { maxUsd: 0 } }).success).toBe(false);
  });
});

describe("scenarios", () => {
  it("defines every scenario with a valid request", () => {
    for (const name of ScenarioName.options) {
      expect(SCENARIOS[name].name).toBe(name);
      expect(ComputeRequest.safeParse(SCENARIOS[name].request).success).toBe(true);
    }
  });

  it("matches the plan's requests (6.4)", () => {
    const gpu = scenarioRequest("gpu-image");
    expect(gpu).toMatchObject({
      workload: "image",
      params: { seed: 7, size: 1024, steps: 4 },
      constraints: { gpu: true, minVramGb: 16, deadlineSec: 60 },
      budget: { maxUsd: 0.05 },
    });
    expect(scenarioRequest("cpu-counter")).toMatchObject({
      params: { preset: "hd-fast" },
      constraints: { deadlineSec: 120 },
      budget: { maxUsd: 0.015 },
    });
    expect(scenarioRequest("cpu-tight")).toMatchObject({
      params: { preset: "hd-heavy" },
      constraints: { deadlineSec: 20 },
      budget: { maxUsd: 0.03 },
    });
    expect(scenarioRequest("failover")).toMatchObject({
      params: { preset: "hd-heavy" },
      constraints: { deadlineSec: 120 },
      budget: { maxUsd: 0.02 },
    });
    expect(scenarioRequest("gpu-image-escrow")).toEqual(gpu);
    expect(SCENARIOS["gpu-image-escrow"].route).toBe("escrow-jobs");
    expect(scenarioRequest("fractal-escrow")).toMatchObject({
      params: { preset: "hd-fast" },
      constraints: { deadlineSec: 120, exclude: ["B", "C"] },
      budget: { maxUsd: 0.05 },
    });
  });

  it("swaps in a fixed prompt and returns a fresh copy", () => {
    const r = scenarioRequest("gpu-image", { promptIndex: 3 });
    expect(r.workload === "image" && r.params.prompt).toBe(IMAGE_PROMPTS[3]);
    expect(scenarioRequest("gpu-image").workload === "image").toBe(true);
    const again = scenarioRequest("gpu-image");
    expect(again.workload === "image" && again.params.prompt).toBe(IMAGE_PROMPTS[0]);
    expect(() => scenarioRequest("gpu-image", { promptIndex: 5 })).toThrow(RangeError);
  });

  it("keeps failover and escrow off the public run button", () => {
    expect([...PUBLIC_SCENARIOS]).toEqual(["gpu-image", "cpu-counter", "cpu-tight"]);
    expect(isPublicScenario("failover")).toBe(false);
    expect(isPublicScenario("gpu-image-escrow")).toBe(false);
    expect(DemoRunRequest.safeParse({ scenario: "nope" }).success).toBe(false);
    expect(DemoRunRequest.safeParse({ scenario: "gpu-image", promptIndex: 4 }).success).toBe(true);
    expect(DemoRunRequest.safeParse({ scenario: "gpu-image", promptIndex: 5 }).success).toBe(false);
  });
});

describe("market types", () => {
  it("orders eligibility checks hardware first, and covers every reason but over_budget", () => {
    expect(ELIGIBILITY_ORDER.slice(0, 3)).toEqual(["excluded", "no_gpu", "vram_too_small"]);
    const covered = new Set<string>([...ELIGIBILITY_ORDER, "over_budget"]);
    expect([...covered].sort()).toEqual([...RejectionReason.options].sort());
  });

  it("parses a quote with a counter-offer", () => {
    const quote = {
      quoteId: "01J9QUOTE",
      request: scenarioRequest("cpu-counter"),
      offers: [],
      counterOffer: { ...offer, reason: "No offer at or below $0.015. Market price $0.03." },
      marketPriceUsd: 0.03,
      rejected: [{ workerId: "A", reason: "over_budget", detail: "$0.05 > $0.015" }],
      expiresAt: NOW,
    };
    expect(Quote.parse(quote).counterOffer?.reason).toMatch(/Market price/);
  });

  it("accepts preprod addresses and assets only", () => {
    expect(CardanoAddress.safeParse(ADDR_A).success).toBe(true);
    expect(CardanoAddress.safeParse(`addr1${"q".repeat(98)}`).success).toBe(false);
    expect(CardanoAddress.safeParse(`addr_test1${"b".repeat(53)}`).success).toBe(false);
    expect(AssetId.safeParse(DEFAULT_ASSET).success).toBe(true);
    expect(AssetId.safeParse("lovelace").success).toBe(true);
    expect(AssetId.safeParse("tUSDM").success).toBe(false);
    expect(Offer.safeParse({ ...offer, priceAtomic: "0.02" }).success).toBe(false);
  });

  it("builds receipts with an explorer link", () => {
    const receipt = PaymentReceipt.parse({
      txHash: TX,
      network: "cardano:preprod",
      payTo: ADDR_A,
      amountAtomic: "20000",
      asset: DEFAULT_ASSET,
      transferMethod: "default",
      feeLovelace: "180000",
      lovelaceInPaymentOutput: "1200000",
      explorerUrl: explorerTxUrl(TX),
      settledAt: NOW,
    });
    expect(receipt.explorerUrl).toBe(`https://preprod.cardanoscan.io/transaction/${TX}`);
    expect(PaymentReceipt.safeParse({ ...receipt, network: "cardano:mainnet" }).success).toBe(
      false,
    );
  });
});

describe("events", () => {
  const env = { id: "01J9EVENT", ts: NOW, runId: "01J9RUN", source: "market" as const };

  it("validates typed data per event type", () => {
    expect(
      JobEvent.safeParse({ ...env, type: "job.progress", data: { workerId: "B", pct: 40 } })
        .success,
    ).toBe(true);
    expect(
      JobEvent.safeParse({ ...env, type: "job.progress", data: { workerId: "B", pct: 140 } })
        .success,
    ).toBe(false);
    expect(JobEvent.safeParse({ ...env, type: "made.up", data: {} }).success).toBe(false);
  });

  it("carries the escrow lock with Masumi's POSIX-ms deadlines", () => {
    const lock = {
      txHash: TX,
      escrowAddress: ADDR_ESCROW,
      sellerAddress: ADDR_A,
      amountAtomic: "50000",
      asset: DEFAULT_ASSET,
      collateralLovelace: "1440000",
      inputHash: SHA,
      payByTime: "1791345600000",
      submitResultTime: "1791346500000",
      unlockTime: "1791347700000",
      externalDisputeUnlockTime: "1791348900000",
      explorerUrl: explorerTxUrl(TX),
    };
    expect(JobEvent.safeParse({ ...env, type: "escrow.locked", data: lock }).success).toBe(true);
    const bad = { ...lock, payByTime: 1791345600000 };
    expect(JobEvent.safeParse({ ...env, type: "escrow.locked", data: bad }).success).toBe(false);
  });

  it("marks dev events and lists every type once", () => {
    const e = JobEvent.parse({
      ...env,
      dev: true,
      type: "job.dispatched",
      data: { workerId: "B", workload: "fractal", kind: "dev", deadlineSec: 60 },
    });
    expect(e.dev).toBe(true);
    expect(JobEvent.safeParse({ ...e, dev: false }).success).toBe(false);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    expect(EVENT_TYPES).toContain("escrow.locked");
  });

  it("keeps the counter-offer's reason in agent.decision", () => {
    const e = JobEvent.parse({
      ...env,
      source: "agent",
      type: "agent.decision",
      data: { kind: "counter", chosen: { ...offer, reason: "within my ceiling" }, reasons: [] },
    });
    expect(e.type === "agent.decision" && e.data.chosen).toMatchObject({
      reason: "within my ceiling",
    });
  });

  it("starts a custom run (the MCP's, the CLI's) and names its client in 40 characters", () => {
    const data = { scenario: "custom", request: scenarioRequest("gpu-image") };
    const started = { ...env, source: "agent" as const, type: "run.started" };
    expect(JobEvent.safeParse({ ...started, data }).success).toBe(true);
    const client = { ...data, client: "Claude via MCP" };
    expect(JobEvent.safeParse({ ...started, data: client }).success).toBe(true);
    const long = { ...data, client: "x".repeat(41) };
    expect(JobEvent.safeParse({ ...started, data: long }).success).toBe(false);
    const unknown = { ...data, scenario: "made-up" };
    expect(JobEvent.safeParse({ ...started, data: unknown }).success).toBe(false);
    expect(RunScenario.options.length).toBe(2);
    expect(isScenarioName("custom")).toBe(false);
    expect(isScenarioName("gpu-image")).toBe(true);
  });

  it("records an over-budget approval as my agent's statement", () => {
    const decision = {
      ...env,
      source: "agent",
      type: "agent.decision",
      data: { kind: "exact", chosen: { ...offer, kind: "exact" }, reasons: ["Luis said yes"] },
    };
    expect(JobEvent.safeParse(decision).success).toBe(true);
    const over = { ...decision.data, overBudget: { budgetUsd: 0.03, priceUsd: 0.05 } };
    const parsed = JobEvent.parse({ ...decision, data: over });
    expect(parsed.type === "agent.decision" && parsed.data.overBudget).toEqual({
      budgetUsd: 0.03,
      priceUsd: 0.05,
    });
    const zero = { ...decision.data, overBudget: { budgetUsd: 0, priceUsd: 0.05 } };
    expect(JobEvent.safeParse({ ...decision, data: zero }).success).toBe(false);
  });

  it("carries the market's PNG check in job.completed", () => {
    const done = { workerId: "A", durationMs: 6900, sha256: SHA, mime: "image/png", bytes: 9 };
    const completed = { ...env, source: "worker", type: "job.completed" };
    expect(JobEvent.safeParse({ ...completed, data: done }).success).toBe(true);
    const check = { kind: "png", width: 1024, height: 1024 };
    expect(JobEvent.safeParse({ ...completed, data: { ...done, check } }).success).toBe(true);
    const jpeg = { ...check, kind: "jpeg" };
    expect(JobEvent.safeParse({ ...completed, data: { ...done, check: jpeg } }).success).toBe(
      false,
    );
  });

  it("describes a release and a refund, seen on chain", () => {
    const common = {
      lockTxHash: TX,
      txHash: SHA,
      buyerAddress: ADDR_A,
      amountAtomic: "50000",
      asset: DEFAULT_ASSET,
      collateralReturnLovelace: "4003990",
      explorerUrl: explorerTxUrl(SHA),
    };
    const chain = { ...env, source: "chain" as const };
    const released = { ...common, sellerAddress: ADDR_A };
    expect(JobEvent.safeParse({ ...chain, type: "escrow.released", data: released }).success).toBe(
      true,
    );
    const noSeller = { ...chain, type: "escrow.released", data: common };
    expect(JobEvent.safeParse(noSeller).success).toBe(false);
    expect(JobEvent.safeParse({ ...chain, type: "escrow.refunded", data: common }).success).toBe(
      true,
    );
    const badAmount = { ...common, collateralReturnLovelace: 4003990 };
    expect(JobEvent.safeParse({ ...chain, type: "escrow.refunded", data: badAmount }).success).toBe(
      false,
    );
  });

  it("names what the chain and the workers report", () => {
    for (const type of [...CHAIN_EVENT_TYPES, ...WORKER_EVENT_TYPES]) {
      expect(EVENT_TYPES).toContain(type);
    }
    expect(CHAIN_EVENT_TYPES).toEqual([
      "payment.settled",
      "escrow.locked",
      "escrow.result_submitted",
      "escrow.released",
      "escrow.refunded",
    ]);
  });

  it("accepts only agent types on /api/agent-events", () => {
    const ok = { events: [{ type: "run.failed", data: { reason: "x" }, runId: "01J9RUN" }] };
    expect(AgentEventsBody.safeParse(ok).success).toBe(true);
    const market = { events: [{ type: "payment.settled", data: {} }] };
    expect(AgentEventsBody.safeParse(market).success).toBe(false);
  });
});

describe("worker WebSocket", () => {
  const hello = {
    type: "hello",
    workerId: "B",
    token: "t",
    version: "abc123",
    name: "Worker B",
    payTo: ADDR_A,
    hardware: { cpuModel: "DO-Premium-Intel", vcpus: 8, memGb: 16 },
    prices: [{ workload: "fractal", usd: 0.03 }],
    warm: ["fractal"],
  };

  it("parses worker messages, narrowing job results by ok", () => {
    expect(WorkerToMarket.parse(hello).type).toBe("hello");
    const ok = WorkerToMarket.parse({
      type: "job.result",
      jobId: "01J9JOB",
      ok: true,
      mime: "image/png",
      sha256: SHA,
      bytes: 3,
      dataBase64: "AAAA",
      durationMs: 1200,
    });
    expect(ok.type === "job.result" && ok.ok && ok.sha256).toBe(SHA);
    const fail = WorkerToMarket.parse({
      type: "job.result",
      jobId: "01J9JOB",
      ok: false,
      error: "killed",
      durationMs: 900,
    });
    expect(fail.type === "job.result" && !fail.ok && fail.error).toBe("killed");
    expect(
      WorkerToMarket.safeParse({ type: "job.result", jobId: "01J9JOB", ok: true, durationMs: 1 })
        .success,
    ).toBe(false);
    expect(WorkerToMarket.safeParse({ ...hello, warm: ["bitcoin-miner"] }).success).toBe(false);
  });

  // The three live workers' hellos, as recorded from the hosted /api/workers on Tue 6 Oct
  // (version: the deployed git sha). The bounds must admit them unchanged.
  const SHA_40 = "3ec29cbbe2d5932f11a7458c8243433c73ffc619";
  const live = [
    {
      workerId: "A",
      name: "Worker A",
      payTo:
        "addr_test1qp8t7ygtvkhvkgscc0ryv8nrt7fprvrnvudyswh82rtuw4w6776etg5mkl5ufe8c3eexxrnh88jtpxq9hh5zqytuawaqxfywga",
      hardware: {
        cpuModel: "INTEL(R) XEON(R) GOLD 6548Y+",
        vcpus: 8,
        memGb: 31.3,
        gpu: { name: "NVIDIA RTX 4000 Ada Generation", vramGb: 20, driver: "580.173.02" },
      },
      prices: [
        { workload: "fractal", usd: 0.05 },
        { workload: "image", usd: 0.05 },
      ],
      warm: ["fractal", "image"],
    },
    {
      workerId: "B",
      name: "Worker B",
      payTo:
        "addr_test1qzxp495qfnhqlj5ame70qkrytf7qnnwtsyg082m706usd3jzz8plsgrv8xgdn6vt0wntg9knn3n264uzafpj0j4atzgqwdl2yr",
      hardware: { cpuModel: "DO-Premium-AMD", vcpus: 8, memGb: 15.6 },
      prices: [{ workload: "fractal", usd: 0.03 }],
      warm: ["fractal"],
    },
    {
      workerId: "C",
      name: "Worker C",
      payTo:
        "addr_test1qpjf3s7yv9mq5r50yvsm494j9g33x5armnql5s3zw5u0q7ujveu2gkz36a9daatgr5wapj30yx88zc42tpkxamqhnl6qr9t2k0",
      hardware: { cpuModel: "DO-Regular", vcpus: 2, memGb: 1.9 },
      prices: [{ workload: "fractal", usd: 0.02 }],
      warm: ["fractal"],
    },
  ].map((w) => ({ type: "hello", token: "t".repeat(32), version: SHA_40, ...w }));

  it("admits the three live workers' hellos unchanged", () => {
    for (const h of live) expect(HelloMsg.parse(h), h.workerId).toEqual(h);
  });

  it("makes the token optional (probation, PR-17)", () => {
    const { token: _, ...anonymous } = hello;
    expect(HelloMsg.safeParse(anonymous).success).toBe(true);
    expect(HelloMsg.safeParse({ ...hello, token: "" }).success).toBe(false);
  });

  it("bounds every string a worker reports, and its prices", () => {
    const a = live[0] as (typeof live)[number];
    const gpu = a.hardware.gpu as { name: string; vramGb: number; driver: string };
    const at = (n: number) => "x".repeat(n);
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      [
        "cpuModel",
        { hardware: { ...a.hardware, cpuModel: at(HELLO_LIMITS.cpuModel) } },
        { hardware: { ...a.hardware, cpuModel: at(HELLO_LIMITS.cpuModel + 1) } },
      ],
      [
        "gpu.name",
        { hardware: { ...a.hardware, gpu: { ...gpu, name: at(64) } } },
        { hardware: { ...a.hardware, gpu: { ...gpu, name: at(65) } } },
      ],
      [
        "driver",
        { hardware: { ...a.hardware, gpu: { ...gpu, driver: at(32) } } },
        { hardware: { ...a.hardware, gpu: { ...gpu, driver: at(33) } } },
      ],
      ["version", { version: at(64) }, { version: at(65) }],
      ["schedule", { schedule: at(64) }, { schedule: at(65) }],
      ["name", { name: at(64) }, { name: at(65) }],
      [
        "prices",
        { prices: Array.from({ length: 4 }, () => ({ workload: "fractal", usd: 0.01 })) },
        { prices: Array.from({ length: 5 }, () => ({ workload: "fractal", usd: 0.01 })) },
      ],
    ];
    for (const [field, fits, over] of cases) {
      expect(HelloMsg.safeParse({ ...a, ...fits }).success, `${field} at the bound`).toBe(true);
      expect(HelloMsg.safeParse({ ...a, ...over }).success, `${field} past the bound`).toBe(false);
    }
    expect(HELLO_LIMITS).toEqual({
      name: 64,
      cpuModel: 80,
      gpuName: 64,
      driver: 32,
      version: 64,
      schedule: 64,
      prices: 4,
    });
  });

  it("lists whether the market sells a worker, and whether it sells through escrow", () => {
    const snapshot = {
      workerId: "A",
      name: "Worker A",
      payTo: ADDR_A,
      hardware: { cpuModel: "x", vcpus: 8, memGb: 32 },
      prices: [],
      status: "online",
      calibration: {},
      warm: [],
      lastSeenAt: NOW,
    };
    expect(WorkerSnapshot.safeParse(snapshot).success).toBe(true);
    const flagged = WorkerSnapshot.parse({ ...snapshot, selling: false, escrowSeller: true });
    expect(flagged).toMatchObject({ selling: false, escrowSeller: true });
  });

  it("pairs dispatch params with the workload", () => {
    const fractal = {
      type: "job.dispatch",
      jobId: "01J9JOB",
      kind: "calibration",
      workload: "fractal",
      params: { preset: "calib", challenge: 2, format: "raw" },
      deadlineSec: 120,
    };
    expect(MarketToWorker.safeParse(fractal).success).toBe(true);
    expect(MarketToWorker.safeParse({ ...fractal, workload: "image" }).success).toBe(false);
    expect(
      DevDispatchRequest.safeParse({ workerId: "B", workload: "fractal", params: { preset: "x" } })
        .success,
    ).toBe(false);
  });
});

describe("UI WebSocket", () => {
  it("starts with a snapshot that includes the demo state", () => {
    const snapshot = UiMessage.parse({
      type: "snapshot",
      workers: [],
      recentEvents: [],
      demo: { running: false, cooldownUntil: null, runsLeftToday: 40 },
    });
    expect(snapshot.type === "snapshot" && snapshot.demo.runsLeftToday).toBe(40);
  });
});
