import {
  type ComputeRequest,
  scenarioRequest,
  usdToAtomic,
  type WorkerSnapshot,
  type WorkloadName,
} from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import { estimateSec } from "./estimates.js";
import { match } from "./match.js";
import { parseSchedule, withinSchedule } from "./schedule.js";

const NOW = new Date("2026-10-06T06:00:00Z"); // 14:00 in Singapore
const AT = NOW.toISOString();
const addr = (c: string) => `addr_test1vq${c.repeat(51)}`;

function worker(
  id: string,
  options: {
    prices: Partial<Record<WorkloadName, number>>;
    spi?: number;
    image?: number;
    gpu?: number;
    status?: WorkerSnapshot["status"];
    warm?: WorkloadName[];
    schedule?: string;
    vcpus?: number;
  },
): WorkerSnapshot {
  const prices = Object.entries(options.prices).map(([workload, usd]) => ({
    workload: workload as WorkloadName,
    usd: usd as number,
    atomic: usdToAtomic(usd as number),
  }));
  return {
    workerId: id,
    name: `Worker ${id}`,
    payTo: addr(id === "A" ? "a" : id === "B" ? "z" : "c"),
    hardware: {
      cpuModel: "test",
      vcpus: options.vcpus ?? 8,
      memGb: 16,
      ...(options.gpu ? { gpu: { name: "RTX 4000 Ada", vramGb: options.gpu, driver: "550" } } : {}),
    },
    prices,
    status: options.status ?? "online",
    calibration: {
      ...(options.spi
        ? {
            fractal: {
              overheadSec: 1,
              calibSec: 2,
              secPerIter: options.spi,
              verified: true,
              challenge: 0,
              at: AT,
            },
          }
        : {}),
      ...(options.image
        ? { image: { secImage1024x4: options.image, verified: false, at: AT } }
        : {}),
    },
    warm: options.warm ?? (Object.keys(options.prices) as WorkloadName[]),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    lastSeenAt: AT,
  };
}

// Tuned like PLAN 6.3: est(B) <= 12 s and est(A) <= 16 s on hd-heavy, 30 s <= est(C) <= 96 s.
const A = worker("A", { prices: { image: 0.05, fractal: 0.05 }, spi: 3.5e-9, image: 9, gpu: 20 });
const B = worker("B", { prices: { fractal: 0.03 }, spi: 2.8e-9 });
const C = worker("C", { prices: { fractal: 0.02 }, spi: 11e-9, vcpus: 2 });
const market = [C, A, B];

const reasons = (r: ReturnType<typeof match>) =>
  Object.fromEntries(r.rejected.map((x) => [x.workerId, `${x.reason}: ${x.detail}`]));

describe("the plan's scenarios (6.4)", () => {
  it("gpu-image: only A fits", () => {
    const r = match(scenarioRequest("gpu-image"), market, NOW);
    expect(r.offers.map((o) => [o.workerId, o.priceUsd, o.estSec])).toEqual([["A", 0.05, 11.8]]);
    expect(r.counterOffer).toBeUndefined();
    expect(r.marketPriceUsd).toBe(0.05);
    expect(reasons(r)).toEqual({ B: "no_gpu: no GPU", C: "no_gpu: no GPU" });
  });

  it("cpu-counter: no exact offer, market $0.03, counter C at $0.02", () => {
    const r = match(scenarioRequest("cpu-counter"), market, NOW);
    expect(r.offers).toEqual([]);
    expect(r.marketPriceUsd).toBe(0.03);
    expect(r.counterOffer?.workerId).toBe("C");
    expect(r.counterOffer?.priceAtomic).toBe("20000");
    expect(r.counterOffer?.reason).toBe(
      "No offer at or below $0.015. Market price $0.03. Next best: C at $0.02, about 14 s",
    );
    expect(reasons(r)).toEqual({
      A: "over_budget: $0.05 > $0.015",
      B: "over_budget: $0.03 > $0.015",
      C: "over_budget: $0.02 > $0.015",
    });
  });

  it("cpu-tight: B; A over budget; C too slow by its measured speed", () => {
    const r = match(scenarioRequest("cpu-tight"), market, NOW);
    expect(r.offers.map((o) => o.workerId)).toEqual(["B"]);
    expect(r.offers[0]?.estSec).toBeLessThanOrEqual(12);
    expect(reasons(r)).toEqual({
      A: "over_budget: $0.05 > $0.03",
      C: "too_slow: about 41 s, deadline 20 s",
    });
    expect(r.marketPriceUsd).toBe(0.03);
  });

  it("failover: C first; without C, the counter-offer is B at $0.03", () => {
    const first = match(scenarioRequest("failover"), market, NOW);
    expect(first.offers.map((o) => o.workerId)).toEqual(["C"]);
    expect(first.offers[0]?.estSec).toBeGreaterThanOrEqual(30);
    expect(first.offers[0]?.estSec).toBeLessThanOrEqual(96);
    const request = scenarioRequest("failover");
    request.constraints.exclude = ["C"];
    const second = match(request, market, NOW);
    expect(second.offers).toEqual([]);
    expect(second.counterOffer?.workerId).toBe("B");
    expect(second.counterOffer?.priceUsd).toBe(0.03);
    expect(reasons(second).C).toBe("excluded: excluded by the request");
  });

  it("fractal-escrow: only A sells through escrow", () => {
    const r = match(scenarioRequest("fractal-escrow"), market, NOW);
    expect(r.offers.map((o) => [o.workerId, o.payTo])).toEqual([["A", A.payTo]]);
    expect(reasons(r)).toEqual({
      B: "excluded: excluded by the request",
      C: "excluded: excluded by the request",
    });
  });
});

describe("every rejection reason", () => {
  const fractal = scenarioRequest("failover");
  const image = scenarioRequest("gpu-image");
  const reasonOf = (request: ComputeRequest, w: WorkerSnapshot, now = NOW) =>
    match(request, [w], now).rejected[0]?.reason ?? "eligible";

  it("names the first failing check, hardware first", () => {
    expect(reasonOf(image, worker("X", { prices: { image: 0.05 }, image: 9, gpu: 8 }))).toBe(
      "vram_too_small",
    );
    // A GPU too small is reported before it being offline or uncalibrated.
    expect(
      reasonOf(image, worker("X", { prices: { image: 0.05 }, gpu: 8, status: "offline" })),
    ).toBe("vram_too_small");
    expect(reasonOf(image, worker("X", { prices: { fractal: 0.05 }, spi: 3e-9, gpu: 20 }))).toBe(
      "no_workload",
    );
    expect(
      reasonOf(image, worker("X", { prices: { image: 0.05 }, image: 9, gpu: 20, warm: [] })),
    ).toBe("no_workload");
    expect(
      reasonOf(fractal, worker("X", { prices: { fractal: 0.02 }, spi: 3e-9, status: "offline" })),
    ).toBe("offline");
    expect(
      reasonOf(fractal, worker("X", { prices: { fractal: 0.02 }, spi: 3e-9, status: "untrusted" })),
    ).toBe("untrusted");
    expect(reasonOf(fractal, worker("X", { prices: { fractal: 0.02 } }))).toBe("not_calibrated");
    expect(
      reasonOf(fractal, worker("X", { prices: { fractal: 0.02 }, spi: 3e-9, status: "busy" })),
    ).toBe("busy");
    expect(
      reasonOf(
        fractal,
        worker("X", { prices: { fractal: 0.02 }, spi: 3e-9, status: "calibrating" }),
      ),
    ).toBe("busy");
    expect(
      reasonOf(
        fractal,
        worker("X", {
          prices: { fractal: 0.02 },
          spi: 3e-9,
          schedule: "09:00-10:00 Asia/Singapore",
        }),
      ),
    ).toBe("outside_hours");
    expect(reasonOf(fractal, worker("X", { prices: { fractal: 0.02 }, spi: 1e-7 }))).toBe(
      "too_slow",
    );
    expect(reasonOf(fractal, worker("X", { prices: { fractal: 0.03 }, spi: 3e-9 }))).toBe(
      "over_budget",
    );
    expect(reasonOf(fractal, worker("X", { prices: { fractal: 0.02 }, spi: 3e-9 }))).toBe(
      "eligible",
    );
  });

  it("covers every reason in the protocol", async () => {
    const { RejectionReason } = await import("@pekkah/protocol");
    expect(RejectionReason.options).toHaveLength(11);
  });
});

describe("ordering, ties and the market price", () => {
  const request = scenarioRequest("failover"); // hd-heavy, 120 s, $0.02
  request.budget.maxUsd = 0.1;

  it("sorts by price, then estimate, then worker id", () => {
    const workers = [
      worker("D", { prices: { fractal: 0.02 }, spi: 5e-9 }),
      worker("E", { prices: { fractal: 0.02 }, spi: 3e-9 }),
      worker("F", { prices: { fractal: 0.02 }, spi: 3e-9 }),
      worker("G", { prices: { fractal: 0.01 }, spi: 9e-9 }),
    ];
    expect(match(request, workers, NOW).offers.map((o) => o.workerId)).toEqual([
      "G",
      "E",
      "F",
      "D",
    ]);
  });

  it("takes the lower middle price for an even count, and null with nobody eligible", () => {
    const four = [0.01, 0.02, 0.03, 0.04].map((usd, i) =>
      worker(`W${i}`, { prices: { fractal: usd }, spi: 3e-9 }),
    );
    expect(match(request, four, NOW).marketPriceUsd).toBe(0.02);
    expect(match(request, four.slice(0, 3), NOW).marketPriceUsd).toBe(0.02);
    expect(match(request, [], NOW)).toEqual({ offers: [], marketPriceUsd: null, rejected: [] });
  });

  it("compares the budget in atomic units, so the boundary is inclusive", () => {
    request.budget.maxUsd = 0.03;
    const w = worker("B", { prices: { fractal: 0.03 }, spi: 3e-9 });
    expect(match(request, [w], NOW).offers).toHaveLength(1);
  });
});

describe("estimates", () => {
  it("keeps the fixed cost unscaled and adds the margin to the work", () => {
    expect(estimateSec(scenarioRequest("cpu-tight"), B)).toBe(11.2); // 1 + 2.8e-9 * 3.16e9 * 1.15
    expect(estimateSec(scenarioRequest("gpu-image"), A)).toBe(11.8); // 1 + 9 * 1.2
    const small = scenarioRequest("gpu-image");
    if (small.workload === "image") small.params = { ...small.params, size: 768, steps: 2 };
    expect(estimateSec(small, A)).toBe(4); // 1 + 9 * 0.5 * 0.5625 * 1.2
    expect(estimateSec(scenarioRequest("gpu-image"), B)).toBeNull();
  });
});

describe("live hours", () => {
  it("parses and checks a schedule in its time zone, overnight included", () => {
    expect(parseSchedule("09:00-23:00 Asia/Singapore")).toEqual({
      startMin: 540,
      endMin: 1380,
      timeZone: "Asia/Singapore",
    });
    expect(withinSchedule("09:00-23:00 Asia/Singapore", NOW)).toBe(true); // 14:00
    expect(withinSchedule("15:00-23:00 Asia/Singapore", NOW)).toBe(false);
    expect(withinSchedule("22:00-15:00 Asia/Singapore", NOW)).toBe(true); // overnight
    expect(withinSchedule("22:00-06:00 Asia/Singapore", NOW)).toBe(false);
    expect(withinSchedule("14:00-14:30 Asia/Singapore", NOW)).toBe(true);
    expect(withinSchedule("13:00-14:00 Asia/Singapore", NOW)).toBe(false); // end is exclusive
  });

  it("treats a missing or unreadable schedule as always open", () => {
    expect(withinSchedule(undefined, NOW)).toBe(true);
    expect(withinSchedule("whenever", NOW)).toBe(true);
    expect(withinSchedule("09:00-10:00 Mars/Olympus", NOW)).toBe(true);
    expect(parseSchedule("25:00-26:00 UTC")).toBeNull();
  });
});
