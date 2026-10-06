import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type MarketToWorker, WorkerSnapshot } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EventBus } from "./events.js";
import { parseWorkerTokens, WorkerRegistry } from "./workers.js";

const TOKEN = "k".repeat(32);
const ADDR = `addr_test1vq${"q".repeat(51)}`;
const log = createLogger("workers-test");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function market(silentMs = 15_000) {
  const bus = new EventBus(log);
  const calibrations: string[] = [];
  const registry = new WorkerRegistry({
    tokens: parseWorkerTokens(`B:${TOKEN},C:${"c".repeat(32)}`),
    bus,
    log,
    silentMs,
    calibrate: (_r, workerId, workload) => void calibrations.push(`${workerId}:${workload}`),
  });
  const server: Server = createServer();
  registry.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  cleanup.push(() => {
    registry.close();
    server.close();
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/worker`;
  return { registry, bus, url, calibrations };
}

async function worker(url: string, token = TOKEN, hello: Record<string, unknown> = {}) {
  const ws = new WebSocket(url);
  const inbox: MarketToWorker[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (data) => {
    inbox.push(JSON.parse(data.toString()));
    for (const w of waiters.splice(0)) w();
  });
  await new Promise((resolve) => ws.once("open", resolve));
  cleanup.push(() => ws.terminate());
  const next = async (type: string): Promise<MarketToWorker> => {
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0] as MarketToWorker;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const send = (msg: unknown) => ws.send(JSON.stringify(msg));
  send({
    type: "hello",
    workerId: "B",
    token,
    version: "test",
    name: "Worker B",
    payTo: ADDR,
    hardware: { cpuModel: "test", vcpus: 8, memGb: 16 },
    prices: [{ workload: "fractal", usd: 0.03 }],
    warm: ["fractal"],
    ...hello,
  });
  return { ws, next, send };
}

describe("worker registry", () => {
  it("refuses a worker with a wrong token", async () => {
    const { url, registry } = await market();
    const w = await worker(url, "wrong".repeat(8));
    const error = await w.next("error");
    expect(error).toMatchObject({ type: "error", code: "unauthorized" });
    await new Promise((resolve) => w.ws.once("close", resolve));
    expect(registry.snapshots()).toEqual([]);
  });

  it("refuses a hello whose price cannot be converted, and keeps serving", async () => {
    const { url, registry } = await market();
    const bad = await worker(url, TOKEN, { prices: [{ workload: "fractal", usd: 1e300 }] });
    expect(await bad.next("error")).toMatchObject({ type: "error", code: "invalid_hello" });
    await new Promise((resolve) => bad.ws.once("close", resolve));
    expect(registry.snapshots()).toEqual([]);
    const good = await worker(url);
    expect(await good.next("welcome")).toMatchObject({ workerId: "B" });
  });

  it("welcomes a worker, asks for calibration, and reports it in /api/workers", async () => {
    const { url, registry, calibrations } = await market();
    const w = await worker(url);
    expect(await w.next("welcome")).toMatchObject({ workerId: "B" });
    expect(calibrations).toEqual(["B:fractal"]);
    const [snapshot] = registry.snapshots();
    expect(WorkerSnapshot.parse(snapshot)).toMatchObject({
      workerId: "B",
      status: "online",
      warm: ["fractal"],
      prices: [{ workload: "fractal", usd: 0.03, atomic: "30000" }],
    });
    expect(registry.online()).toBe(1);
  });

  it("dispatches a job, checks the hash itself, and emits job events", async () => {
    const { url, registry, bus } = await market();
    const w = await worker(url);
    await w.next("welcome");
    const pending = registry.dispatch("B", {
      workload: "fractal",
      params: { preset: "tiny", palette: "ember", format: "raw" },
      kind: "dev",
      deadlineSec: 30,
      dev: true,
    });
    const dispatch = await w.next("job.dispatch");
    if (dispatch.type !== "job.dispatch") throw new Error("expected a dispatch");
    expect(registry.snapshots()[0]?.status).toBe("busy");
    w.send({ type: "job.accepted", jobId: dispatch.jobId });
    const data = Buffer.from("result bytes");
    const sha256 = createHash("sha256").update(data).digest("hex");
    w.send({
      type: "job.result",
      jobId: dispatch.jobId,
      ok: true,
      mime: "application/octet-stream",
      sha256,
      bytes: data.length,
      dataBase64: data.toString("base64"),
      durationMs: 5,
    });
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: true, sha256, workerId: "B" });
    const types = bus.latest().map((e) => `${e.type}${e.dev ? " dev" : ""}`);
    expect(types).toEqual([
      "worker.online",
      "job.dispatched dev",
      "job.running dev",
      "job.completed dev",
    ]);
  });

  it("refuses a result whose bytes do not match its hash", async () => {
    const { url, registry } = await market();
    const w = await worker(url);
    await w.next("welcome");
    const pending = registry.dispatch("B", {
      workload: "fractal",
      params: { preset: "tiny", palette: "ember", format: "raw" },
      kind: "dev",
      deadlineSec: 30,
    });
    const dispatch = await w.next("job.dispatch");
    if (dispatch.type !== "job.dispatch") throw new Error("expected a dispatch");
    w.send({
      type: "job.result",
      jobId: dispatch.jobId,
      ok: true,
      mime: "application/octet-stream",
      sha256: "0".repeat(64),
      bytes: 3,
      dataBase64: Buffer.from("abc").toString("base64"),
      durationMs: 5,
    });
    expect(await pending).toMatchObject({ ok: false, error: "result corrupted in transit" });
  });

  it("fails a running job when the worker disconnects, and marks it offline", async () => {
    const { url, registry } = await market();
    const w = await worker(url);
    await w.next("welcome");
    const pending = registry.dispatch("B", {
      workload: "fractal",
      params: { preset: "tiny", palette: "ember", format: "raw" },
      kind: "dev",
      deadlineSec: 30,
    });
    await w.next("job.dispatch");
    w.ws.terminate();
    expect(await pending).toMatchObject({ ok: false, error: "worker disconnected" });
    expect(registry.snapshots()[0]?.status).toBe("offline");
    expect(
      await registry.dispatch("B", {
        workload: "fractal",
        params: { preset: "tiny", palette: "ember", format: "raw" },
        kind: "dev",
        deadlineSec: 5,
      }),
    ).toMatchObject({
      ok: false,
      error: "worker offline",
    });
  });

  it("marks a silent worker offline", async () => {
    const { url, registry } = await market(150);
    const w = await worker(url);
    await w.next("welcome");
    expect(registry.snapshots()[0]?.status).toBe("online");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(registry.snapshots()[0]?.status).toBe("offline");
  });

  it("parses WORKER_TOKENS", () => {
    expect([...parseWorkerTokens("A:aa, B:bb ,bad,C:")]).toEqual([
      ["A", "aa"],
      ["B", "bb"],
    ]);
  });
});
