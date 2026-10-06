import {
  explorerTxUrl,
  NETWORK,
  type PaymentReceipt,
  PaymentReceipt as ReceiptSchema,
} from "@pekkah/protocol";
import { decodeSignedTx } from "./tx.js";

type ReadonlyDeep<T> = { readonly [K in keyof T]: T[K] };

export interface ReceiptInput {
  paymentPayload: { readonly payload: Readonly<Record<string, unknown>> };
  requirements: ReadonlyDeep<{
    payTo: string;
    amount: string;
    asset: string;
    extra: Readonly<Record<string, unknown>>;
  }>;
  settle: ReadonlyDeep<{ transaction: string; extra?: Readonly<Record<string, unknown>> }>;
  settledAt?: Date;
}

/**
 * The receipt for a settled payment. Fee and minimum ADA come from the decoded signed
 * transaction, so the receipt can say honestly that about 1.2 tADA travels with every token
 * payment.
 */
export function buildReceipt({
  paymentPayload,
  requirements,
  settle,
  settledAt,
}: ReceiptInput): PaymentReceipt {
  const tx = decodeSignedTx(paymentPayload);
  const txHash = settle.transaction || tx.txHash;
  // A missing assetTransferMethod means default (core strips "default" from the 402).
  const transferMethod = requirements.extra.assetTransferMethod === "masumi" ? "masumi" : "default";
  const paymentOutput = tx.outputs.find(
    (o) =>
      o.address === requirements.payTo &&
      (o.assets[requirements.asset] ?? 0n) >= BigInt(requirements.amount),
  );
  const confirmations = settle.extra?.confirmations;
  return ReceiptSchema.parse({
    txHash,
    network: NETWORK,
    payTo: requirements.payTo,
    amountAtomic: requirements.amount,
    asset: requirements.asset,
    transferMethod,
    ...(typeof confirmations === "number" ? { confirmations } : {}),
    feeLovelace: tx.fee.toString(),
    ...(paymentOutput ? { lovelaceInPaymentOutput: paymentOutput.coin.toString() } : {}),
    explorerUrl: explorerTxUrl(txHash),
    settledAt: (settledAt ?? new Date()).toISOString(),
  });
}
