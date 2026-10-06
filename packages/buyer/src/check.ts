import { MAX_TIMEOUT_SECONDS, NETWORK } from "@pekkah/protocol";
import { jcs, masumiEscrowAddress } from "@x402/cardano";

/** What the agent accepted: the offer, or for smoke tests the seller address and price. */
export interface PaymentExpectation {
  /** default: the worker's address. masumi: the escrow address (checked independently too). */
  payTo: string;
  amountAtomic: string;
  asset: string;
  transferMethod?: "default" | "masumi";
  /** masumi: the worker that must be the seller in the signed terms. */
  seller?: string;
  /** masumi, when buying an offer: the request the agent quoted (the `parameters` part). */
  parameters?: unknown;
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
  if (method === "masumi") return checkMasumi(req, expect);
  return `transfer method ${String(method)} is not supported`;
}

interface CommitmentPart {
  name?: unknown;
  content?: unknown;
}

/**
 * A Masumi 402 locks the funds at the escrow address with the worker as seller. The signer
 * only checks that the commitment's digests are consistent, not that they describe my
 * request, so the `parameters` part is compared with the request the agent quoted.
 */
function checkMasumi(req: RequirementsLike, expect: PaymentExpectation): string | null {
  const escrow = masumiEscrowAddress(NETWORK);
  if (req.payTo !== escrow) return `payTo ${req.payTo} is not the Masumi escrow ${escrow}`;
  if (expect.payTo !== escrow) return `expected payTo ${expect.payTo} is not the Masumi escrow`;
  if (!expect.seller) return "no expected seller for a Masumi payment";
  const terms = req.extra?.terms as { sellerAddress?: unknown } | undefined;
  if (terms?.sellerAddress !== expect.seller) {
    return `escrow seller ${String(terms?.sellerAddress)} is not the expected worker ${expect.seller}`;
  }
  if (expect.parameters !== undefined) {
    const commitment = req.extra?.inputCommitment as { parts?: CommitmentPart[] } | undefined;
    const part = commitment?.parts?.find((p) => p.name === "parameters");
    if (!part || part.content === undefined) return "the escrow does not commit to my request";
    if (jcs(part.content) !== jcs(expect.parameters)) {
      return "the escrow commits to a different request than the one I quoted";
    }
  }
  return null;
}
