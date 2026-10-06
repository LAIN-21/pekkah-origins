import { decodeSignedTx, type ResourceServerOptions } from "@pekkah/payments";
import { type EscrowLock, EscrowLock as EscrowLockSchema, explorerTxUrl } from "@pekkah/protocol";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { OfferStore } from "./offers.js";
import { escrowOfferIdFromPath } from "./paid.js";

type Commitment = NonNullable<NonNullable<ResourceServerOptions["masumi"]>["commitment"]>;

/**
 * What a Masumi escrow is bound to (PLAN 4.8). One callback serves every Masumi route: for
 * /api/escrow-jobs/:offerId it is the exact request the agent quoted (`parameters`), so the
 * escrow's input hash commits to it; for the smoke route it is the resource URL, as the
 * library's default (not exported) does. The content is echoed in the 402, which the buyer
 * needs: it recomputes every part before signing.
 */
export function escrowCommitment(offers: OfferStore): Commitment {
  return (context) => {
    const request = (context.transportContext as { request?: { path?: unknown } } | undefined)
      ?.request;
    const offerId = typeof request?.path === "string" ? escrowOfferIdFromPath(request.path) : null;
    if (offerId) {
      const record = offers.get(offerId);
      // The pre-check answered 404 already; this only guards a race with the offer store.
      if (!record) throw new Error(`unknown offer ${offerId}`);
      return [{ name: "parameters", canonicalization: "jcs", content: record.request }];
    }
    return [
      {
        name: "resource",
        canonicalization: "jcs",
        mediaType: "application/json",
        content: { url: context.resourceInfo.url },
      },
    ];
  };
}

/**
 * The escrow.locked event's data (PLAN 5.2, 12.3), from the seller-signed terms the payment
 * accepted and the lock output of the transaction that landed. Returns why not when the
 * transaction has no escrow output with an inline datum: nothing is reported that is not
 * on chain.
 */
export function escrowLock(input: {
  txHash: string;
  requirements: PaymentRequirements;
  paymentPayload: Pick<PaymentPayload, "payload">;
}): { lock: EscrowLock } | { error: string } {
  const { requirements } = input;
  const terms = (requirements.extra as { terms?: Record<string, unknown> } | undefined)?.terms;
  if (!terms) return { error: "the requirements carry no Masumi terms" };
  const tx = decodeSignedTx(input.paymentPayload);
  const output = tx.outputs.find(
    (o) =>
      o.address === requirements.payTo &&
      (o.assets[requirements.asset] ?? 0n) >= BigInt(requirements.amount),
  );
  if (!output) return { error: "the transaction has no output at the escrow address" };
  if (!output.datum) return { error: "the escrow output has no inline datum" };
  const parsed = EscrowLockSchema.safeParse({
    txHash: input.txHash,
    escrowAddress: requirements.payTo,
    sellerAddress: terms.sellerAddress,
    amountAtomic: requirements.amount,
    asset: requirements.asset,
    collateralLovelace: output.coin.toString(),
    inputHash: terms.inputHash,
    payByTime: terms.payByTime,
    submitResultTime: terms.submitResultTime,
    unlockTime: terms.unlockTime,
    externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
    explorerUrl: explorerTxUrl(input.txHash),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `unexpected terms: ${issue?.path.join(".")} ${issue?.message}` };
  }
  return { lock: parsed.data };
}
