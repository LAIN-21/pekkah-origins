import { PUBLIC_SCENARIOS, SCENARIOS } from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import { publicQuotes, quoteShape } from "./smoke-quotes.js";

const offer = (offerId: string, expiresAt: string) => ({
  offerId,
  quoteId: "Q1",
  workerId: "B",
  priceAtomic: "30000",
  estSec: 11.2,
  expiresAt,
  kind: "exact",
});

describe("install-smoke quotes", () => {
  it("drop ids and times, and keep everything else", () => {
    const a = {
      quoteId: "Q1",
      runId: "R1",
      offers: [offer("O1", "2026-10-07T01:00:00Z")],
      rejected: [{ workerId: "C", reason: "too_slow", detail: "about 44 s > 20 s" }],
      marketPriceUsd: 0.03,
      expiresAt: "2026-10-07T01:00:00Z",
    };
    const b = { ...a, quoteId: "Q2", offers: [offer("O2", "2026-10-07T01:05:00Z")] };
    expect(quoteShape(a)).toEqual(quoteShape(b));
    expect(quoteShape(a)).toEqual({
      offers: [{ workerId: "B", priceAtomic: "30000", estSec: 11.2, kind: "exact" }],
      rejected: [{ workerId: "C", reason: "too_slow", detail: "about 44 s > 20 s" }],
      marketPriceUsd: 0.03,
    });
  });

  it("notice a new worker anywhere in the quote", () => {
    const before = { offers: [], rejected: [{ workerId: "C", reason: "busy", detail: "" }] };
    const after = {
      offers: [],
      rejected: [...before.rejected, { workerId: "joining-1a2b3c", reason: "busy", detail: "" }],
    };
    expect(quoteShape(after)).not.toEqual(quoteShape(before));
  });

  it("ask for the three public scenarios with their real requests", async () => {
    const bodies: unknown[] = [];
    const fake = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ quoteId: "Q", offers: [] }), { status: 200 });
    }) as typeof fetch;
    const out = await publicQuotes("https://market.example", fake);
    expect(Object.keys(out)).toEqual([...PUBLIC_SCENARIOS]);
    expect(bodies).toEqual(PUBLIC_SCENARIOS.map((name) => SCENARIOS[name].request));
  });
});
