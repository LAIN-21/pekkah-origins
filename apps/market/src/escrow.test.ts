import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_ASSET,
  type JobEvent,
  NETWORK,
  Quote,
  type ScenarioName,
  scenarioRequest,
} from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { masumiEscrowAddress, toMasumiSellerSigner } from "@x402/cardano";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { parametersInputHash } from "../../../packages/payments/src/server.js";
import { buildTestTx } from "../../../packages/payments/src/test-support/cardano-tx.js";
import { txHashFromPayload } from "../../../packages/payments/src/tx.js";
import { throwawayMnemonic } from "../../../packages/runtime/src/test-support/mnemonic.js";
import { createApp } from "./app.js";
import { escrowCommitment, escrowLock } from "./escrow.js";
import { EventBus } from "./events.js";
import { JobStore } from "./jobs.js";
import { OfferStore } from "./offers.js";
import { registerPaidJobRoute } from "./paid.js";
import { createMarketPayments } from "./payments.js";
import { registerQuoteRoute } from "./quotes.js";
import { registerReadRoutes } from "./routes.js";
import { RunStore } from "./runs.js";
import { parseWorkerTokens, WorkerRegistry } from "./workers.js";

const log = createLogger("escrow-test");
const B_ADDR = `addr_test1vq${"z".repeat(51)}`;
const ESCROW = masumiEscrowAddress(NETWORK);
// Worker A is the Masumi seller, as in the demo: its payout address is the seller's address.
const seller = toMasumiSellerSigner({ mnemonic: throwawayMnemonic(), network: NETWORK });
const calls = { settle: 0 };

// Test-only stand-in for the facilitator: every payment verifies and settles.
const facilitator: FacilitatorClient = {
  async verify() {
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
const events: JobEvent[] = [];
const sockets: WebSocket[] = [];
const cleanup: (() => void)[] = [];

function fakeWorker(port: number, workerId: string, payTo: string, usd: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`);
  sockets.push(ws);
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "job.dispatch") return;
    ws.send(JSON.stringify({ type: "job.accepted", jobId: msg.jobId }));
    const data = Buffer.from(`png bytes from ${workerId}`);
    ws.send(
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
  ws.once("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        workerId,
        token: workerId.toLowerCase().repeat(32),
        version: "test",
        name: `Worker ${workerId}`,
        payTo,
        hardware: { cpuModel: "test", vcpus: 8, memGb: 16 },
        prices: [{ workload: "fractal", usd }],
        warm: ["fractal"],
      }),
    ),
  );
}

beforeAll(async () => {
  const bus = new EventBus(log);
  bus.subscribe((event) => void events.push(event));
  const offers = new OfferStore();
  const jobs = new JobStore();
  const runs = new RunStore(bus, null, log);
  const payments = createMarketPayments(
    { facilitator, masumi: { seller, commitment: escrowCommitment(offers) } },
    bus,
    log,
    { jobs, offers },
  );
  const registry = new WorkerRegistry({
    tokens: parseWorkerTokens(`A:${"a".repeat(32)},B:${"b".repeat(32)}`),
    bus,
    log,
  });
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
        asset: DEFAULT_ASSET,
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
        masumi: { sellerAddress: seller.sellerAddress, asset: DEFAULT_ASSET, unpaidPerMinute: 6 },
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
  fakeWorker(port, "A", seller.sellerAddress, 0.05);
  fakeWorker(port, "B", B_ADDR, 0.03);
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const id of ["A", "B"]) {
    registry.setCalibration(id, {
      fractal: {
        overheadSec: 1,
        calibSec: 2,
        secPerIter: 2.8e-9,
        verified: true,
        challenge: 0,
        at: new Date().toISOString(),
      },
    });
  }
});
afterAll(() => {
  for (const ws of sockets) ws.terminate();
  for (const fn of cleanup) fn();
});

async function offerFor(scenario: ScenarioName) {
  const res = await fetch(`${url}/api/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scenarioRequest(scenario)),
  });
  const offer = Quote.parse(await res.json()).offers[0];
  if (!offer) throw new Error(`no offer for ${scenario}`);
  return offer;
}

async function required402(offerId: string) {
  const res = await fetch(`${url}/api/escrow-jobs/${offerId}`, { method: "POST" });
  expect(res.status).toBe(402);
  const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
  const accepted = required.accepts[0] as PaymentRequirements;
  const extra = accepted.extra as {
    assetTransferMethod: string;
    terms: Record<string, string>;
    inputCommitment: { digest: string; parts: Record<string, unknown>[] };
  };
  return { required, accepted, extra };
}

function lockTx(accepted: PaymentRequirements, seed: number, datum?: number[]) {
  return buildTestTx({
    seed,
    payTo: ESCROW,
    amount: BigInt(accepted.amount),
    paymentCoin: 2_000_000n,
    ...(datum ? { datum } : {}),
  });
}

describe("POST /api/escrow-jobs/:offerId", () => {
  it("quotes a lock at the escrow, worker A as seller, bound to the quoted request", async () => {
    const offer = await offerFor("fractal-escrow");
    expect(offer.workerId).toBe("A");
    const { accepted, extra } = await required402(offer.offerId);
    expect(accepted).toMatchObject({
      payTo: ESCROW,
      amount: offer.priceAtomic,
      asset: DEFAULT_ASSET,
    });
    expect(extra.assetTransferMethod).toBe("masumi");
    expect(extra.terms.sellerAddress).toBe(seller.sellerAddress);
    expect(extra.inputCommitment.parts).toHaveLength(1);
    expect(extra.inputCommitment.parts[0]).toMatchObject({
      name: "parameters",
      canonicalization: "jcs",
      content: scenarioRequest("fractal-escrow"),
    });
    expect(extra.terms.inputHash).toBe(extra.inputCommitment.digest);
    // Anyone can recompute it from the request alone (demo-check does).
    expect(extra.terms.inputHash).toBe(parametersInputHash(scenarioRequest("fractal-escrow")));
    const requiredEvent = events.find(
      (e) => e.type === "payment.required" && e.data.offerId === offer.offerId,
    );
    expect(requiredEvent?.data).toMatchObject({
      workerId: "A",
      payTo: ESCROW,
      transferMethod: "masumi",
    });
  });

  it("runs the job, then locks: escrow.locked carries the signed terms and the collateral", async () => {
    const offer = await offerFor("fractal-escrow");
    const { required, accepted, extra } = await required402(offer.offerId);
    const tx = lockTx(accepted, 21, [1, 2, 3]);
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: { transaction: tx.transaction, nonce: `${"02".repeat(32)}#0` },
    };
    const settledBefore = calls.settle;
    const res = await fetch(`${url}/api/escrow-jobs/${offer.offerId}`, {
      method: "POST",
      headers: { "payment-signature": encodePaymentSignatureHeader(payload) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workerId: "A", txHash: tx.txHash });
    expect(calls.settle).toBe(settledBefore + 1);

    const mine = events.filter(
      (e) =>
        ("txHash" in e.data && e.data.txHash === tx.txHash) ||
        (e.type === "receipt.issued" && e.data.receipt.txHash === tx.txHash),
    );
    expect(mine.map((e) => e.type)).toEqual([
      "payment.verified",
      "job.dispatched",
      "payment.settling",
      "payment.settled",
      "escrow.locked",
      "receipt.issued",
    ]);
    const settling = mine.find((e) => e.type === "payment.settling");
    expect(settling?.data).toMatchObject({ transferMethod: "masumi" });
    const verified = mine.find((e) => e.type === "payment.verified");
    expect(verified?.data).toMatchObject({ payTo: ESCROW, transferMethod: "masumi" });
    const locked = mine.find((e) => e.type === "escrow.locked");
    expect(locked?.data).toEqual({
      txHash: tx.txHash,
      escrowAddress: ESCROW,
      sellerAddress: seller.sellerAddress,
      amountAtomic: offer.priceAtomic,
      asset: DEFAULT_ASSET,
      collateralLovelace: "2000000",
      inputHash: extra.terms.inputHash,
      payByTime: extra.terms.payByTime,
      submitResultTime: extra.terms.submitResultTime,
      unlockTime: extra.terms.unlockTime,
      externalDisputeUnlockTime: extra.terms.externalDisputeUnlockTime,
      explorerUrl: `https://preprod.cardanoscan.io/transaction/${tx.txHash}`,
    });
    const receipt = mine.find((e) => e.type === "receipt.issued");
    expect(receipt?.type === "receipt.issued" && receipt.data.receipt).toMatchObject({
      transferMethod: "masumi",
      payTo: ESCROW,
    });
  });

  it("refuses escrow for an offer whose worker is not the Masumi seller", async () => {
    const offer = await offerFor("cpu-tight");
    expect(offer.workerId).toBe("B");
    const res = await fetch(`${url}/api/escrow-jobs/${offer.offerId}`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_a_masumi_seller" });
  });

  it("reports no lock for a transaction without an inline datum", async () => {
    const offer = await offerFor("fractal-escrow");
    const { accepted } = await required402(offer.offerId);
    const tx = lockTx(accepted, 22);
    const result = escrowLock({
      txHash: tx.txHash,
      requirements: accepted,
      paymentPayload: { payload: { transaction: tx.transaction } },
    });
    expect(result).toEqual({ error: "the escrow output has no inline datum" });
  });

  it("limits unpaid escrow 402s, since each one signs a fresh seller quote", async () => {
    const offer = await offerFor("fractal-escrow");
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${url}/api/escrow-jobs/${offer.offerId}`, { method: "POST" });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 402).length).toBeLessThanOrEqual(6);
  });
});
