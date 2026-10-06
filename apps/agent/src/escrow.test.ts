import { DEFAULT_ASSET, MASUMI_LOCK_LABEL, NETWORK } from "@pekkah/protocol";
import { masumiEscrowAddress } from "@x402/cardano";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { buildTestTx } from "../../../packages/payments/src/test-support/cardano-tx.js";
import { escrowLines, escrowReceipt } from "./escrow.js";

const ESCROW = masumiEscrowAddress(NETWORK);
const SELLER = `addr_test1vq${"a".repeat(51)}`;
const terms = {
  sellerAddress: SELLER,
  inputHash: "ab".repeat(32),
  payByTime: "1791300000000",
  submitResultTime: "1791300900000",
  unlockTime: "1791302100000",
  externalDisputeUnlockTime: "1791303300000",
};
const accepted: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: DEFAULT_ASSET,
  amount: "50000",
  payTo: ESCROW,
  maxTimeoutSeconds: 600,
  extra: { assetTransferMethod: "masumi", terms },
};

function header(datum?: number[]) {
  const tx = buildTestTx({
    seed: 9,
    payTo: ESCROW,
    amount: 50_000n,
    paymentCoin: 1_440_000n,
    ...(datum ? { datum } : {}),
  });
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: { url: "https://market.test/api/escrow-jobs/01OFFER" },
    accepted,
    payload: { transaction: tx.transaction, nonce: `${"03".repeat(32)}#0` },
  });
}

describe("escrow receipt", () => {
  it("reads the signed terms and the lock output of the signed transaction", () => {
    expect(escrowReceipt(accepted, header([1, 2]))).toEqual({
      escrowAddress: ESCROW,
      sellerAddress: SELLER,
      inputHash: terms.inputHash,
      amountAtomic: "50000",
      asset: DEFAULT_ASSET,
      collateralLovelace: "1440000",
      inlineDatum: true,
      payByTime: terms.payByTime,
      submitResultTime: terms.submitResultTime,
      unlockTime: terms.unlockTime,
      externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
    });
    expect(escrowReceipt(accepted, header()).inlineDatum).toBe(false);
  });

  it("says locked in escrow, never paid or released", () => {
    const text = escrowLines(escrowReceipt(accepted, header([1])), "A").join("\n");
    expect(text).toContain("in Masumi escrow");
    expect(text).toContain(MASUMI_LOCK_LABEL);
    expect(text).toContain(`seller     worker A (${SELLER})`);
    expect(text).toMatch(/payBy {6}\d{4}-\d\d-\d\d \d\d:\d\d:\d\d SGT/);
    expect(text).not.toMatch(/\bpaid\b|released/i);
  });
});
