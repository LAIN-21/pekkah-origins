import { DEFAULT_ASSET, NETWORK } from "@pekkah/protocol";
import type { FacilitatorClient, HTTPAdapter, HTTPTransportContext } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { PaymentOperations } from "./operations.js";
import { attachPaymentHooks, createResourceServer } from "./server.js";
import { buildTestTx, type TestTx } from "./test-support/cardano-tx.js";
import { decodeSignedTx, txHashFromPayload } from "./tx.js";

// The real x402ResourceServer runs every hook; only the facilitator is a test stub.
async function setup() {
  const calls = { verify: 0, settle: 0 };
  const facilitator: FacilitatorClient = {
    async verify() {
      calls.verify += 1;
      return { isValid: true, payer: "addr_test1buyer" };
    },
    async settle(paymentPayload) {
      calls.settle += 1;
      return {
        success: true,
        transaction: txHashFromPayload(paymentPayload),
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
  const server = createResourceServer({ facilitator });
  const operations = new PaymentOperations();
  const events: string[] = [];
  attachPaymentHooks(server, operations, {
    keyOf: (request) => request?.path.split("/").pop() ?? null,
    onSettling: ({ txHash }) => void events.push(`settling ${txHash.slice(0, 4)}`),
    onSettled: ({ txHash, receipt }) =>
      void events.push(`settled ${txHash.slice(0, 4)} fee=${receipt.feeLovelace}`),
    onCanceled: ({ txHash, reason }) =>
      void events.push(`canceled ${txHash.slice(0, 4)} ${reason}`),
  });
  await server.initialize();
  return { server, operations, events, calls };
}

function transport(path: string): HTTPTransportContext {
  const adapter = { getPath: () => path, getMethod: () => "POST" } as unknown as HTTPAdapter;
  return { request: { adapter, path, method: "POST" } };
}

async function paymentFor(server: Awaited<ReturnType<typeof setup>>["server"], tx: TestTx) {
  const payTo =
    decodeSignedTx({ payload: { transaction: tx.transaction } }).outputs[0]?.address ?? "";
  const [requirements] = (await server.buildPaymentRequirements({
    scheme: "exact",
    network: NETWORK,
    payTo,
    price: { amount: "10000", asset: DEFAULT_ASSET },
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: "default", confirmationPolicy: { l1Confirmations: 0 } },
  })) as [PaymentRequirements];
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: tx.transaction, nonce: `${"01".repeat(32)}#0` },
  };
  return { payload, requirements };
}

describe("payment hooks on the real resource server", () => {
  it("claims the offer, refuses a racing payment, and resumes without verifying again", async () => {
    const { server, operations, calls, events } = await setup();
    const tx1 = buildTestTx({ seed: 1 });
    const tx2 = buildTestTx({ seed: 2 });
    const p1 = await paymentFor(server, tx1);
    const p2 = await paymentFor(server, tx2);

    const first = await server.verifyPayment(
      p1.payload,
      p1.requirements,
      undefined,
      transport("/api/jobs/offer-1"),
    );
    expect(first.isValid).toBe(true);
    expect(operations.holder("offer-1")).toBe(tx1.txHash);
    expect(operations.isVerified(tx1.txHash)).toBe(true);

    const racing = await server.verifyPayment(
      p2.payload,
      p2.requirements,
      undefined,
      transport("/api/jobs/offer-1"),
    );
    expect(racing).toMatchObject({ isValid: false, invalidReason: "offer_already_purchased" });
    expect(operations.holder("offer-1")).toBe(tx1.txHash);

    const resumed = await server.verifyPayment(
      p1.payload,
      p1.requirements,
      undefined,
      transport("/api/jobs/offer-1"),
    );
    expect(resumed.isValid).toBe(true);
    expect(calls.verify).toBe(2);
    expect(events).toEqual([]);
  });

  it("settles once, and answers a replay from the stored settlement", async () => {
    const { server, calls, events } = await setup();
    const tx = buildTestTx({ seed: 3 });
    const p = await paymentFor(server, tx);
    const ctx = transport("/api/jobs/offer-3");
    await server.verifyPayment(p.payload, p.requirements, undefined, ctx);
    const settle = await server.settlePayment(p.payload, p.requirements, undefined, ctx);
    expect(settle).toMatchObject({ success: true, transaction: tx.txHash });
    const replay = await server.settlePayment(p.payload, p.requirements, undefined, ctx);
    expect(replay).toMatchObject({ success: true, transaction: tx.txHash });
    expect(calls.settle).toBe(1);
    expect(events).toEqual([
      `settling ${tx.txHash.slice(0, 4)}`,
      `settled ${tx.txHash.slice(0, 4)} fee=${tx.fee}`,
    ]);
  });

  it("cancels a failed job once and never for a refused racing payment", async () => {
    const { server, operations, events } = await setup();
    const holderTx = buildTestTx({ seed: 4 });
    const racerTx = buildTestTx({ seed: 5 });
    const holder = await paymentFor(server, holderTx);
    const racer = await paymentFor(server, racerTx);
    const ctx = transport("/api/jobs/offer-4");
    await server.verifyPayment(holder.payload, holder.requirements, undefined, ctx);
    await server.verifyPayment(racer.payload, racer.requirements, undefined, ctx);
    expect(operations.holder("offer-4")).toBe(holderTx.txHash);

    const dispatcher = server.createPaymentCancellationDispatcher(
      holder.payload,
      holder.requirements,
      undefined,
      ctx,
    );
    await dispatcher.cancel({ reason: "handler_failed", responseStatus: 502 });
    await server
      .createPaymentCancellationDispatcher(holder.payload, holder.requirements, undefined, ctx)
      .cancel({ reason: "handler_failed", responseStatus: 502 });
    expect(operations.get(holderTx.txHash)?.canceled).toBe("handler_failed");
    expect(events).toEqual([`canceled ${holderTx.txHash.slice(0, 4)} handler_failed`]);
  });

  it("refuses a payment for a path it cannot map to a resource", async () => {
    const { server } = await setup();
    const p = await paymentFor(server, buildTestTx({ seed: 6 }));
    const result = await server.verifyPayment(p.payload, p.requirements, undefined, undefined);
    expect(result).toMatchObject({ isValid: false, invalidReason: "unknown_resource" });
  });
});
