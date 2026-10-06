import { createHash } from "node:crypto";
import { type DecodedCardanoTransaction, decodeCardanoTransaction } from "@x402/cardano";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";

type PayloadLike =
  | Pick<PaymentPayload, "payload">
  | { readonly payload: Readonly<Record<string, unknown>> };

/** Decodes the signed (not yet broadcast) transaction a payment carries. */
export function decodeSignedTx(paymentPayload: PayloadLike): DecodedCardanoTransaction {
  const transaction = paymentPayload.payload.transaction;
  if (typeof transaction !== "string" || transaction.length === 0) {
    throw new Error("payment payload has no transaction");
  }
  return decodeCardanoTransaction(transaction);
}

/** The txHash is known from the moment the agent signs: it is the idempotency key. */
export function txHashFromPayload(paymentPayload: PayloadLike): string {
  return decodeSignedTx(paymentPayload).txHash;
}

export function txHashFromPaymentHeader(header: string): string {
  return txHashFromPayload(decodePaymentSignatureHeader(header));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = stable((value as never)[key]);
    return out;
  }
  return value;
}

/** Identifies the exact payload, witnesses included, so a resumed request must be byte-for-byte the same payment. */
export function payloadFingerprint(
  paymentPayload: Pick<PaymentPayload, "payload" | "accepted"> | Readonly<Record<string, unknown>>,
): string {
  const { payload, accepted } = paymentPayload as { payload: unknown; accepted: unknown };
  return createHash("sha256")
    .update(JSON.stringify(stable({ payload, accepted })))
    .digest("hex");
}
