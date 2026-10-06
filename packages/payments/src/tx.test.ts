import { DEFAULT_ASSET } from "@pekkah/protocol";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { buildReceipt } from "./receipt.js";
import { buildTestTx } from "./test-support/cardano-tx.js";
import {
  decodeSignedTx,
  payloadFingerprint,
  txHashFromPayload,
  txHashFromPaymentHeader,
} from "./tx.js";

function payloadFor(transaction: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "cardano:preprod",
      asset: DEFAULT_ASSET,
      amount: "10000",
      payTo: "addr_test1placeholder",
      maxTimeoutSeconds: 600,
      extra: {},
    },
    payload: { transaction, nonce: `${"01".repeat(32)}#0` },
  };
}

describe("txHash extraction", () => {
  it("computes the txHash from the signed payload, before broadcast", () => {
    const tx = buildTestTx();
    expect(txHashFromPayload(payloadFor(tx.transaction))).toBe(tx.txHash);
  });

  it("reads the same txHash from a PAYMENT-SIGNATURE header", () => {
    const tx = buildTestTx({ seed: 7 });
    const header = encodePaymentSignatureHeader(payloadFor(tx.transaction));
    expect(txHashFromPaymentHeader(header)).toBe(tx.txHash);
  });

  it("refuses a payload without a transaction", () => {
    expect(() => txHashFromPayload({ payload: {} })).toThrow(/no transaction/);
    expect(() => txHashFromPayload({ payload: { transaction: "not base64 cbor" } })).toThrow();
  });

  it("fingerprints the exact payload", () => {
    const a = payloadFor(buildTestTx({ seed: 1 }).transaction);
    const b = payloadFor(buildTestTx({ seed: 2 }).transaction);
    expect(payloadFingerprint(a)).toBe(payloadFingerprint(structuredClone(a)));
    expect(payloadFingerprint(a)).not.toBe(payloadFingerprint(b));
    const reordered = {
      accepted: a.accepted,
      payload: { nonce: a.payload.nonce, transaction: a.payload.transaction },
    };
    expect(payloadFingerprint(reordered)).toBe(payloadFingerprint(a));
  });
});

describe("receipts", () => {
  it("takes fee and minimum ADA from the decoded transaction", () => {
    const tx = buildTestTx({ seed: 3 });
    const payload = payloadFor(tx.transaction);
    const payTo = decodeSignedTx(payload).outputs[0]?.address ?? "";
    expect(payTo).toMatch(/^addr_test1/);
    const receipt = buildReceipt({
      paymentPayload: payload,
      requirements: { payTo, amount: "10000", asset: DEFAULT_ASSET, extra: {} },
      settle: { transaction: tx.txHash, extra: { status: "confirmed", confirmations: 0 } },
      settledAt: new Date("2026-10-06T14:00:00Z"),
    });
    expect(receipt).toEqual({
      txHash: tx.txHash,
      network: "cardano:preprod",
      payTo,
      amountAtomic: "10000",
      asset: DEFAULT_ASSET,
      transferMethod: "default",
      confirmations: 0,
      feeLovelace: tx.fee.toString(),
      lovelaceInPaymentOutput: tx.paymentCoin.toString(),
      explorerUrl: `https://preprod.cardanoscan.io/transaction/${tx.txHash}`,
      settledAt: "2026-10-06T14:00:00.000Z",
    });
  });

  it("treats a missing assetTransferMethod as default and marks masumi", () => {
    const tx = buildTestTx({ seed: 4 });
    const payload = payloadFor(tx.transaction);
    const payTo = decodeSignedTx(payload).outputs[0]?.address ?? "";
    const base = { payTo, amount: "10000", asset: DEFAULT_ASSET };
    const settle = { transaction: tx.txHash };
    expect(
      buildReceipt({ paymentPayload: payload, requirements: { ...base, extra: {} }, settle })
        .transferMethod,
    ).toBe("default");
    expect(
      buildReceipt({
        paymentPayload: payload,
        requirements: { ...base, extra: { assetTransferMethod: "masumi" } },
        settle,
      }).transferMethod,
    ).toBe("masumi");
  });
});
