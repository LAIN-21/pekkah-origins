import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@pekkah/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DemoController } from "./demo.js";
import { EventBus } from "./events.js";

const log = createLogger("demo-test");
const AGENT_TOKEN = "a".repeat(32);
let agentUrl = "";
let server: Server;
const received: { auth?: string; body: unknown }[] = [];
let agentStatus = 202;

beforeAll(async () => {
  // A stand-in for the agent service: records each run it is handed.
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
      res.writeHead(agentStatus, { "content-type": "application/json" }).end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function controller(now: { t: number }, dailyRuns = 40) {
  const bus = new EventBus(log);
  let changes = 0;
  const demo = new DemoController({
    agentUrl,
    agentToken: AGENT_TOKEN,
    cooldownSec: 120,
    dailyRuns,
    bus,
    log,
    onChange: () => {
      changes += 1;
    },
    now: () => now.t,
  });
  const end = (runId: string) =>
    bus.emit({
      source: "agent",
      type: "run.completed",
      runId,
      data: { jobId: "J", workerId: "B", txHash: "a".repeat(64), totalMs: 1 },
    });
  return { demo, end, changes: () => changes };
}

describe("the run button", () => {
  it("starts a public run, hands it to the agent, and refuses a second one meanwhile", async () => {
    const now = { t: Date.parse("2026-10-07T02:00:00Z") };
    const { demo, end, changes } = controller(now);
    const started = await demo.start({ scenario: "cpu-tight" }, false);
    expect(started.status).toBe(202);
    const runId = (started.body as { runId: string }).runId;
    expect(received.at(-1)).toEqual({
      auth: `Bearer ${AGENT_TOKEN}`,
      body: { scenario: "cpu-tight", runId },
    });
    expect(demo.state()).toMatchObject({ running: true, runId, runsLeftToday: 39 });
    expect((await demo.start({ scenario: "gpu-image" }, true)).status).toBe(409);
    end(runId);
    expect(demo.state()).toMatchObject({ running: false, runsLeftToday: 39 });
    expect(demo.state().cooldownUntil).toBe(new Date(now.t + 120_000).toISOString());
    expect(changes()).toBe(2);
  });

  it("enforces the cooldown and the daily cap, except with DEMO_TOKEN", async () => {
    const now = { t: Date.parse("2026-10-07T03:00:00Z") };
    const { demo, end } = controller(now, 1);
    const first = await demo.start({ scenario: "cpu-counter" }, false);
    end((first.body as { runId: string }).runId);
    now.t += 60_000;
    expect(await demo.start({ scenario: "cpu-counter" }, false)).toMatchObject({
      status: 429,
      body: { error: "cooldown" },
    });
    now.t += 61_000;
    expect(await demo.start({ scenario: "cpu-counter" }, false)).toMatchObject({
      status: 429,
      body: { error: "daily_limit" },
    });
    const privileged = await demo.start({ scenario: "failover" }, true);
    expect(privileged.status).toBe(202);
    end((privileged.body as { runId: string }).runId);
    // A new day in Singapore resets the cap.
    now.t = Date.parse("2026-10-07T16:30:00Z");
    expect((await demo.start({ scenario: "cpu-counter" }, false)).status).toBe(202);
  });

  it("keeps failover and escrow off the public button", async () => {
    const { demo } = controller({ t: Date.now() });
    expect(await demo.start({ scenario: "failover" }, false)).toMatchObject({ status: 403 });
    expect(await demo.start({ scenario: "gpu-image-escrow" }, false)).toMatchObject({
      status: 403,
    });
  });

  it("does not count a run the agent refused", async () => {
    const { demo } = controller({ t: Date.now() });
    agentStatus = 409;
    expect(await demo.start({ scenario: "cpu-tight" }, false)).toMatchObject({
      status: 502,
      body: { error: "agent_unavailable" },
    });
    agentStatus = 202;
    expect(demo.state()).toMatchObject({ running: false, runsLeftToday: 40 });
  });
});
