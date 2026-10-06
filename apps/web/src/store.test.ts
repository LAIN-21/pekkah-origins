import { describe, expect, it } from "vitest";
import { fixtureRunLog } from "./dev/fixture";
import { feedReducer, initialFeed } from "./store";

const demo = { running: false, cooldownUntil: null, runsLeftToday: 40 };

describe("feedReducer", () => {
  it("merges snapshot and live events without duplicates, in emission order", () => {
    const log = fixtureRunLog("cpu-tight");
    const [first, second, third] = log.events;
    if (!first || !second || !third) throw new Error("fixture too short");
    let s = feedReducer(initialFeed, {
      type: "message",
      message: { type: "snapshot", workers: [], recentEvents: [second, first], demo },
    });
    s = feedReducer(s, { type: "message", message: { type: "event", event: second } });
    s = feedReducer(s, { type: "message", message: { type: "event", event: third } });
    expect(s.events.map((e) => e.id)).toEqual([first.id, second.id, third.id]);
  });

  it("remembers which runs were seen live", () => {
    const log = fixtureRunLog("gpu-image");
    const event = log.events[0];
    if (!event) throw new Error("fixture too short");
    const s = feedReducer(initialFeed, { type: "message", message: { type: "event", event } });
    expect(s.liveRunIds).toEqual([log.runId]);
    const snapshotOnly = feedReducer(initialFeed, {
      type: "message",
      message: { type: "snapshot", workers: [], recentEvents: [event], demo },
    });
    expect(snapshotOnly.liveRunIds).toEqual([]);
  });

  it("takes workers and demo state from the latest message", () => {
    const s = feedReducer(initialFeed, {
      type: "message",
      message: { type: "demo", demo: { ...demo, running: true, runId: "r1" } },
    });
    expect(s.demo?.running).toBe(true);
    expect(feedReducer(s, { type: "connection", connection: "closed" }).connection).toBe("closed");
  });
});
