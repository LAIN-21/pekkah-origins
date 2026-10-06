import type { JobEvent } from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import { describeEvent } from "./describe";
import { fixtureRunLog } from "./dev/fixture";

const name = (id: string) => `Worker ${id}`;

describe("describeEvent", () => {
  it("doesn't count the counter-offer's worker as ruled out", () => {
    const quote = fixtureRunLog("cpu-counter").events.find((e) => e.type === "quote.issued");
    if (!quote) throw new Error("no quote");
    const line = describeEvent(quote, name);
    expect(line.title).toBe("No exact match: the market made a counter-offer");
    expect(line.detail).toBe("Market price: $0.03. 2 workers ruled out.");
  });

  it("counts every rejected worker when there is no counter-offer", () => {
    const quote = fixtureRunLog("cpu-tight").events.find((e) => e.type === "quote.issued");
    if (!quote) throw new Error("no quote");
    expect(describeEvent(quote, name).detail).toBe("Market price: $0.03. 2 workers ruled out.");
  });

  it("describes a preset run by its scenario, and a custom run by its request and client", () => {
    const preset = fixtureRunLog("gpu-image").events.find((e) => e.type === "run.started");
    const custom = fixtureRunLog("mcp").events.find((e) => e.type === "run.started");
    if (!preset || !custom) throw new Error("no run.started");
    expect(describeEvent(preset, name)).toMatchObject({ title: "My agent started a run" });
    expect(describeEvent(preset, name).detail).toMatch(/^My agent needs an image/);
    expect(describeEvent(custom, name)).toEqual({
      title: "Claude via MCP started a run",
      detail:
        "An image: “a poster of a lighthouse at dusk”. 1024², 4 steps · GPU ≥ 16 GB · deadline 60 s · budget $0.03.",
      tone: "info",
    });
  });

  it("names a re-quote without exclusions plainly", () => {
    const line = describeEvent(
      {
        id: "e1",
        ts: new Date().toISOString(),
        source: "agent",
        type: "agent.reroute",
        data: { excluded: [], reason: "The offer expired." },
      } as JobEvent,
      name,
    );
    expect(line.title).toBe("My agent asks again");
  });
});
