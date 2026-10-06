import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NETWORK, Quote, scenarioRequest } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildTestTx } from "../../../packages/payments/src/test-support/cardano-tx.js";
import { txHashFromPayload } from "../../../packages/payments/src/tx.js";
import { createApp } from "./app.js";
import { EventBus } from "./events.js";
import { JobStore } from "./jobs.js";
import { OfferStore } from "./offers.js";
import { registerPaidJobRoute } from "./paid.js";
import { createMarketPayments } from "./payments.js";
import { registerQuoteRoute } from "./quotes.js";
import { registerReadRoutes } from "./routes.js";
import { RunStore } from "./runs.js";
import { parseWorkerTokens, WorkerRegistry } from "./workers.js";

const log = createLogger("paid-test");
const TOKEN = "w".repeat(32);
const B_ADDR = `addr_test1vq${"z".repeat(51)}`;
const calls = { verify: 0, settle: 0 };

// Test-only stand-in for the facilitator: every payment verifies and settles.
const facilitator: FacilitatorClient = {
  async verify() {
    calls.verify += 1;
    return { isValid: true, payer: "addr_test1buyer" };
  },
  async settle(payload) {
    calls.settle += 1;
    return {
      success: true,
      transaction: txHashFromPayload(payload),
      network: NETWORK,
      extra: { status: "confirmed", confirmations: 0 },
    };
  },
  async getSupported() {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: NETWORK,
          extra: {
            assetTransferMethods: ["default", "masumi", "script"],
            areFeesSponsored: false,
            l1Confirmations: { minimum: 0, maximum: 20 },
          },
        },
      ],
      extensions: [],
      signers: {},
    };
  },
};

let url = "";
let bus: EventBus;
let jobs: JobStore;
let worker: WebSocket;
const dispatches: string[] = [];
let failNext = false;
const cleanup: (() => void)[] = [];

beforeAll(async () => {
  bus = new EventBus(log);
  const offers = new OfferStore();
  jobs = new JobStore();
  const runs = new RunStore(bus, null, log);
  const payments = createMarketPayments({ facilitator }, bus, log, { jobs, offers });
  const registry = new WorkerRegistry({ tokens: parseWorkerTokens(`B:${TOKEN}`), bus, log });
  const app = createApp({
    version: "0.1.0",
    sha: "test",
    webDist: null,
    workersOnline: () => registry.online(),
    routes: (app) => {
      registerQuoteRoute(app, {
        workers: () => registry.snapshots(),
        offers,
        bus,
        asset: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d",
        log,
      });
      registerPaidJobRoute(app, {
        ...payments,
        offers,
        jobs,
        registry,
        bus,
        l1Confirmations: 0,
        log,
        perMinute: 1000,
      });
      registerReadRoutes(app, { jobs, runs, facilitatorUrl: "http://127.0.0.1:9", log });
    },
  });
  const server = app.listen(0, "127.0.0.1");
  registry.attach(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  cleanup.push(() => {
    registry.close();
    server.close();
  });

  // A fake worker B: answers every dispatch with a fixed result, or fails on request.
  worker = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`);
  await new Promise((resolve) => worker.once("open", resolve));
  worker.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "job.dispatch") return;
    dispatches.push(msg.jobId);
    worker.send(JSON.stringify({ type: "job.accepted", jobId: msg.jobId }));
    if (failNext) {
      failNext = false;
      worker.send(
        JSON.stringify({
          type: "job.result",
          jobId: msg.jobId,
          ok: false,
          error: "killed",
          durationMs: 5,
        }),
      );
      return;
    }
    const data = Buffer.from("png bytes");
    worker.send(
      JSON.stringify({
        type: "job.result",
        jobId: msg.jobId,
        ok: true,
        mime: "image/png",
        sha256: createHash("sha256").update(data).digest("hex"),
        bytes: data.length,
        dataBase64: data.toString("base64"),
        durationMs: 5,
      }),
    );
  });
  worker.send(
    JSON.stringify({
      type: "hello",
      workerId: "B",
      token: TOKEN,
      version: "test",
      name: "Worker B",
      payTo: B_ADDR,
      hardware: { cpuModel: "test", vcpus: 8, memGb: 16 },
      prices: [{ workload: "fractal", usd: 0.03 }],
      warm: ["fractal"],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  registry.setCalibration("B", {
    fractal: {
      overheadSec: 1,
      calibSec: 2,
      secPerIter: 2.8e-9,
      verified: true,
      challenge: 0,
      at: new Date().toISOString(),
    },
  });
});
afterAll(() => {
  worker?.terminate();
  for (const fn of cleanup) fn();
});

async function quote(runId: string) {
  const res = await fetch(`${url}/api/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Pekkah-Run-Id": runId },
    body: JSON.stringify(scenarioRequest("cpu-tight")),
  });
  const q = Quote.parse(await res.json());
  const offer = q.offers[0];
  if (!offer) throw new Error(`no offer: ${JSON.stringify(q.rejected)}`);
  return offer;
}

async function pay(offerId: string, seed: number) {
  const unpaid = await fetch(`${url}/api/jobs/${offerId}`, { method: "POST" });
  expect(unpaid.status).toBe(402);
  const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
  const accepted = required.accepts[0];
  if (!accepted) throw new Error("no accepts");
  const tx = buildTestTx({ seed });
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { transaction: tx.transaction, nonce: `${"01".repeat(32)}#0` },
  };
  const header = encodePaymentSignatureHeader(payload);
  const post = () =>
    fetch(`${url}/api/jobs/${offerId}`, {
      method: "POST",
      headers: { "payment-signature": header },
    });
  return { accepted, tx, header, post };
}

describe("POST /api/jobs/:offerId", () => {
  it("asks an unpaid request to pay the offer's worker the offer's price", async () => {
    const offer = await quote("01RUNA");
    const res = await fetch(`${url}/api/jobs/${offer.offerId}`, { method: "POST" });
    expect(res.status).toBe(402);
    const [accept] = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "").accepts;
    expect(accept).toMatchObject({ payTo: B_ADDR, amount: "30000", network: NETWORK });
    expect((await fetch(`${url}/api/jobs/nope`, { method: "POST" })).status).toBe(404);
  });

  it("runs the job, settles after delivery, and replays without a second job or payment", async () => {
    const offer = await quote("01RUNB");
    const { tx, post } = await pay(offer.offerId, 21);
    const before = { ...calls, dispatches: dispatches.length };
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resultUrl: string };
    expect(body).toMatchObject({ workerId: "B", txHash: tx.txHash, mime: "image/png" });
    expect(decodePaymentResponseHeader(res.headers.get("payment-response") ?? "")).toMatchObject({
      success: true,
      transaction: tx.txHash,
    });
    const result = await fetch(`${url}${body.resultUrl}`);
    expect(result.status).toBe(200);
    expect(Buffer.from(await result.arrayBuffer()).toString()).toBe("png bytes");

    const replay = await post();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    expect(dispatches.length - before.dispatches).toBe(1);
    expect(calls.settle - before.settle).toBe(1);

    const types = bus
      .latest()
      .filter((e) => e.runId === "01RUNB")
      .map((e) => e.type);
    expect(types).toEqual([
      "quote.issued",
      "payment.required",
      "payment.verified",
      "job.dispatched",
      "job.running",
      "job.completed",
      "payment.settling",
      "payment.settled",
      "receipt.issued",
    ]);
    const job = await (await fetch(`${url}/api/jobs/by-tx/${tx.txHash}`)).json();
    expect(job).toMatchObject({ status: "delivered", paid: true, offerId: offer.offerId });
  });

  it("refuses a replay whose job was trimmed from memory, and keeps the payment settled", async () => {
    const offer = await quote("01RUNT");
    const { tx, post } = await pay(offer.offerId, 51);
    expect((await post()).status).toBe(200);
    // Push the job out of the store's 200-job window.
    for (let i = 0; i < 200; i++) {
      jobs.add({
        jobId: `01FILL${String(i).padStart(4, "0")}`,
        offerId: `fill${i}`,
        workerId: "B",
        workload: "fractal",
        txHash: (i + 1).toString(16).padStart(64, "0"),
        status: "delivered",
        startedAt: new Date().toISOString(),
        paid: true,
        done: Promise.resolve(),
      });
    }
    const dispatched = dispatches.length;
    const replay = await post();
    expect(replay.status).toBe(410);
    expect(await replay.json()).toEqual({ error: "job_expired" });
    expect(dispatches.length).toBe(dispatched);
    const canceled = bus
      .latest()
      .filter((e) => e.type === "payment.canceled" && e.data.txHash === tx.txHash);
    expect(canceled).toEqual([]);
  });

  it("refuses a second payment for a bought offer", async () => {
    const offer = await quote("01RUNC");
    const first = await pay(offer.offerId, 31);
    expect((await first.post()).status).toBe(200);
    const tx = buildTestTx({ seed: 32 });
    const rival = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: first.accepted,
      payload: { transaction: tx.transaction, nonce: `${"02".repeat(32)}#0` },
    });
    const res = await fetch(`${url}/api/jobs/${offer.offerId}`, {
      method: "POST",
      headers: { "payment-signature": rival },
    });
    expect(res.status).toBe(409);
  });

  it("answers 502 when the job fails, so nothing is settled, and closes the offer", async () => {
    const offer = await quote("01RUND");
    const { tx, post } = await pay(offer.offerId, 41);
    failNext = true;
    const settles = calls.settle;
    const res = await post();
    expect(res.status).toBe(502);
    expect(res.headers.get("payment-response")).toBeNull();
    expect(calls.settle).toBe(settles);
    const job = await (await fetch(`${url}/api/jobs/by-tx/${tx.txHash}`)).json();
    expect(job).toMatchObject({ status: "failed", paid: false, error: "killed" });
    expect(
      bus
        .latest()
        .filter((e) => e.runId === "01RUND")
        .map((e) => e.type),
    ).toContain("payment.canceled");
    expect((await fetch(`${url}/api/jobs/${offer.offerId}`, { method: "POST" })).status).toBe(410);
  });
});
