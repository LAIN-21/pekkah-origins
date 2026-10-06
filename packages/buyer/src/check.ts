import { MAX_TIMEOUT_SECONDS, NETWORK } from "@pekkah/protocol";

/** What the agent accepted: the offer, or for smoke tests the seller address and price. */
export interface PaymentExpectation {
  payTo: string;
  amountAtomic: string;
  asset: string;
  transferMethod?: "default" | "masumi";
}

/** The fields of a 402's selected requirements that the check reads. */
export interface RequirementsLike {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Readonly<Record<string, unknown>>;
}

/**
 * Refuses to sign unless the 402 asks for exactly what the agent accepted (PLAN 4.7). Returns
 * the reason to refuse, or null. A missing assetTransferMethod means `default`: core strips it
 * from the 402 it sends.
 */
export function check402(req: RequirementsLike, expect: PaymentExpectation): string | null {
  if (req.scheme !== "exact") return `scheme ${req.scheme} is not exact`;
  if (req.network !== NETWORK) return `network ${req.network} is not ${NETWORK}`;
  if (req.asset !== expect.asset) return `asset ${req.asset} is not ${expect.asset}`;
  if (req.amount !== expect.amountAtomic) {
    return `amount ${req.amount} is not the accepted ${expect.amountAtomic}`;
  }
  if (!(req.maxTimeoutSeconds > 0 && req.maxTimeoutSeconds <= MAX_TIMEOUT_SECONDS)) {
    return `maxTimeoutSeconds ${req.maxTimeoutSeconds} is outside 1..${MAX_TIMEOUT_SECONDS}`;
  }
  const flow = req.extra?.paymentFlow;
  if (flow !== undefined && flow !== "authorization") return `payment flow ${String(flow)} refused`;

  const method = req.extra?.assetTransferMethod ?? "default";
  const wanted = expect.transferMethod ?? "default";
  if (method !== wanted) return `transfer method ${String(method)} is not ${wanted}`;
  if (method === "default") {
    return req.payTo === expect.payTo
      ? null
      : `payTo ${req.payTo} is not the accepted address ${expect.payTo}`;
  }
  return `transfer method ${String(method)} is not supported yet`;
}
