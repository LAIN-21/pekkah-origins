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

  it("describes a preset run by its scenario, and a custom run without one", () => {
    const preset = fixtureRunLog("gpu-image").events.find((e) => e.type === "run.started");
    if (!preset) throw new Error("no run.started");
    // PR-13 lets run.started carry scenario "custom". The cast keeps this compiling before and after.
    const custom = {
      ...preset,
      data: { ...preset.data, scenario: "custom" },
    } as unknown as JobEvent;
    expect(describeEvent(preset, name).detail).toMatch(/^My agent needs an image/);
    expect(describeEvent(custom, name)).toEqual({ title: "My agent started a run", tone: "info" });
  });
});
