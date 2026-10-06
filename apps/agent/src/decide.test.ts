import { DEFAULT_ASSET, type Offer, type Quote, scenarioRequest } from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import { decide, PRIVATE_CEILINGS_USD } from "./decide.js";

const offer = (workerId: string, usd: number, estSec: number): Offer => ({
  offerId: `O${workerId}`,
  quoteId: "Q",
  workerId,
  workload: "fractal",
  priceUsd: usd,
  priceAtomic: String(Math.round(usd * 1e6)),
  asset: DEFAULT_ASSET,
  payTo: `addr_test1vq${"q".repeat(51)}`,
  estSec,
  expiresAt: new Date().toISOString(),
  kind: "exact",
});

const quote = (
  over: Partial<Quote>,
  scenario: "cpu-counter" | "cpu-tight" = "cpu-counter",
): Quote => ({
  quoteId: "Q",
  request: scenarioRequest(scenario),
  offers: [],
  marketPriceUsd: 0.03,
  rejected: [],
  expiresAt: new Date().toISOString(),
  ...over,
});

const counter = (usd: number, estSec: number) => ({
  ...offer("C", usd, estSec),
  kind: "counter" as const,
  reason: "No offer at or below $0.015. Market price $0.03. Next best: C at $0.02, about 31 s",
});

describe("decide", () => {
  it("takes the exact offer at the top", () => {
    const d = decide(
      quote({ offers: [offer("B", 0.03, 11), offer("A", 0.05, 14)] }, "cpu-tight"),
      0.03,
    );
    expect(d.kind).toBe("exact");
    expect(d.chosen?.workerId).toBe("B");
    expect(d.reasons[0]).toBe("B offers $0.03, about 11 s, within my budget of $0.03.");
  });

  it("accepts cpu-counter's counter-offer within its private ceiling", () => {
    const d = decide(
      quote({ counterOffer: counter(0.02, 31) }),
      PRIVATE_CEILINGS_USD["cpu-counter"],
    );
    expect(d.kind).toBe("counter");
    expect(d.chosen?.workerId).toBe("C");
    expect(d.reasons.at(-1)).toBe(
      "C at $0.02 is within my private ceiling of $0.03 and my 120 s deadline: accepted.",
    );
  });

  it("declines above the ceiling or past the deadline", () => {
    expect(decide(quote({ counterOffer: counter(0.04, 31) }), 0.03)).toMatchObject({
      kind: "declined",
    });
    expect(decide(quote({ counterOffer: counter(0.02, 130) }), 0.03).reasons.at(-1)).toMatch(
      /misses my 120 s deadline/,
    );
  });

  it("declines when nobody can run the job, with the market's reasons", () => {
    const d = decide(
      quote({ rejected: [{ workerId: "C", reason: "offline", detail: "offline" }] }),
      0.03,
    );
    expect(d).toEqual({
      kind: "declined",
      reasons: ["No worker can run this job now.", "C: offline"],
    });
  });

  it("keeps every scenario's ceiling at or above its budget", () => {
    for (const [name, ceiling] of Object.entries(PRIVATE_CEILINGS_USD)) {
      expect(ceiling, name).toBeGreaterThanOrEqual(scenarioRequest(name as never).budget.maxUsd);
    }
  });
});
