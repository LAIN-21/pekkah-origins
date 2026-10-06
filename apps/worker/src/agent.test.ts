import type { AddressInfo } from "node:net";
import { createLogger } from "@pekkah/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { type Refusal, WorkerAgent } from "./agent.js";
import type { HelloFields } from "./hello.js";
import { refusalMessage } from "./worker.js";

const log = createLogger("agent-test");
log.level = "silent";

const servers: WebSocketServer[] = [];
const agents: WorkerAgent[] = [];
afterEach(() => {
  for (const a of agents.splice(0)) a.stop();
  for (const s of servers.splice(0)) s.close();
});

/** A fake market: `onHello` answers each hello it receives. */
async function market(onHello: (socket: import("ws").WebSocket, hello: unknown) => void) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const hellos: unknown[] = [];
  wss.on("connection", (socket) => {
    socket.once("message", (data) => {
      const msg = JSON.parse(data.toString());
      hellos.push(msg);
      onHello(socket, msg);
    });
  });
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, hellos };
}

function helloWith(cpuModel: string): HelloFields {
  return {
    workerId: "p-1a2b3c",
    token: "t".repeat(32),
    version: "test",
    name: "probe worker",
    payTo: `addr_test1${"q".repeat(98)}`,
    hardware: { cpuModel, vcpus: 2, memGb: 4 },
    prices: [{ workload: "fractal", usd: 0.02 }],
  };
}

function start(url: string, hello: () => Promise<HelloFields>, onRefused?: (r: Refusal) => void) {
  const agent = new WorkerAgent({
    url,
    hello,
    workloads: [],
    sampleUtil: async () => ({ cpuPct: 0 }),
    log,
    ...(onRefused ? { onRefused } : {}),
  });
  agents.push(agent);
  agent.start();
  return agent;
}

describe("worker agent", () => {
  for (const code of ["unauthorized", "invalid_hello"]) {
    it(`stops for good on ${code} instead of reconnecting`, async () => {
      const m = await market((socket) => {
        socket.send(JSON.stringify({ type: "error", code, message: "refused in a test" }));
        socket.close(1008, code);
      });
      const onRefused = vi.fn();
      start(m.url, async () => helloWith("cpu"), onRefused);
      await vi.waitFor(() => expect(onRefused).toHaveBeenCalledOnce());
      expect(onRefused.mock.calls[0]?.[0]).toEqual({ code, message: "refused in a test" });
      // The first reconnect would come after 1 s.
      await new Promise((r) => setTimeout(r, 1_500));
      expect(m.hellos).toHaveLength(1);
      expect(onRefused).toHaveBeenCalledOnce();
    });
  }

  it("reconnects after other closes, with hardware detected again", async () => {
    const m = await market((socket) => socket.close(1011, "market restarting"));
    let detections = 0;
    const onRefused = vi.fn();
    start(m.url, async () => helloWith(`cpu ${++detections}`), onRefused);
    await vi.waitFor(() => expect(m.hellos.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    const models = m.hellos.map((h) => (h as HelloFields).hardware.cpuModel);
    expect(models.slice(0, 2)).toEqual(["cpu 1", "cpu 2"]);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("sends a hello cut to the market's bounds", async () => {
    const m = await market(() => {});
    start(m.url, async () => helloWith("x".repeat(500)));
    await vi.waitFor(() => expect(m.hellos).toHaveLength(1));
    expect((m.hellos[0] as HelloFields).hardware.cpuModel).toHaveLength(80);
  });
});

describe("refusal message", () => {
  it("tells an operator what to fix", () => {
    const text = refusalMessage(
      { code: "unauthorized", message: "unknown worker or bad token" },
      "B",
    );
    expect(text).toContain("refused worker B (unauthorized)");
    expect(text).toContain("WORKER_ID and WORKER_TOKEN");
    expect(text).toContain("Not reconnecting");
  });
});
